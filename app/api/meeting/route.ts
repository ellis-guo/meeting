import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { addLineNumbers, extractJSON } from "@/lib/utils";
import { encrypt, encryptJSON, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { callDashScope, callDashScopeStream } from "@/lib/dashscope";
import { SUMMARY_SMART_PROMPT, SUMMARY_PROGRESS_PROMPT, MEMORY_DIFF_PROMPT } from "@/lib/prompts";
import {
  type SectionContent, type Section, type Summary, type ChunkInput,
  buildSummaryChunks, buildTranscriptChunks, embedAndStore, buildAndStoreParents,
} from "@/lib/chunking";

// ── Streaming JSON helpers ────────────────────────────────────────────────────
// Extract a complete {...} object starting at `start`. Returns null if incomplete.
function extractObject(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (!inString) {
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null;
}

// Extract complete sections from accumulated streaming text. Returns only fully-closed section objects.
function extractCompleteSections(text: string, alreadyEmitted: number): Section[] {
  const sectionsKeyIdx = text.indexOf('"sections"');
  if (sectionsKeyIdx === -1) return [];
  const bracketIdx = text.indexOf("[", sectionsKeyIdx);
  if (bracketIdx === -1) return [];

  const result: Section[] = [];
  let pos = bracketIdx + 1;
  let found = 0;

  while (pos < text.length) {
    while (pos < text.length && /[\s,]/.test(text[pos])) pos++;
    if (pos >= text.length || text[pos] !== "{") break;
    const objStr = extractObject(text, pos);
    if (!objStr) break; // this section is incomplete — stop here
    found++;
    if (found > alreadyEmitted) {
      try { result.push(JSON.parse(objStr) as Section); } catch { break; }
    }
    pos += objStr.length;
  }

  return result;
}

// Extract meta once its object is fully closed.
function extractMeta(text: string): Summary["meta"] | null {
  const keyIdx = text.indexOf('"meta"');
  if (keyIdx === -1) return null;
  const braceIdx = text.indexOf("{", keyIdx);
  if (braceIdx === -1) return null;
  const objStr = extractObject(text, braceIdx);
  if (!objStr) return null;
  try { return JSON.parse(objStr) as Summary["meta"]; } catch { return null; }
}

// ── Types (re-exported from lib for local use) ────────────────────────────────
// SectionContent, Section, Summary, ChunkInput are imported from @/lib/chunking

// ── GET: list standalone meetings ─────────────────────────────────────────────
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const meetings = await prisma.meeting.findMany({
    where: { user_id: userId, project_id: null },
    select: { id: true, created_at: true, summary: true },
    orderBy: { created_at: "desc" },
    take: 20,
  });

  return NextResponse.json({
    meetings: meetings.map((m) => {
      let date: string | null = null;
      try { date = (decryptJSON<{ meta?: { date?: string | null } }>(m.summary))?.meta?.date ?? null; } catch { /* ignore */ }
      return { id: m.id, created_at: m.created_at, date };
    }),
  });
}

// ── POST: generate summary via SSE ────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) return NextResponse.json({ error: "API key required. Please configure your DashScope API key in Settings." }, { status: 401 });

  const lang = req.cookies.get("lang_pref")?.value ?? "zh";
  const langRule = lang === "en"
    ? "Output language: English. Retain original form for technical terms and proper nouns."
    : "输出语言：以中文为主，学术名词、专有名词、代码标识符保留英文原文。";

  const { transcript, template = "smart", date, time, project_id } = await req.json();
  if (!transcript?.trim()) return NextResponse.json({ error: "transcript is required" }, { status: 400 });

  let project: { id: string; document: unknown } | null = null;
  if (project_id) {
    const raw = await prisma.project.findFirst({ where: { id: project_id, user_id: userId } });
    if (!raw) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    project = { id: raw.id, document: raw.document ? decryptJSON(raw.document) : {} };
  }

  const numbered = addLineNumbers(transcript);
  const systemPrompt = template === "project" ? SUMMARY_PROGRESS_PROMPT : SUMMARY_SMART_PROMPT;
  const contextLines = [
    project ? `<project_context>\n${JSON.stringify(project.document)}\n</project_context>` : null,
    date ? `会议日期：${date}` : null,
    time ? `会议时间：${time}` : null,
    `以下是会议记录：\n\n${numbered}`,
  ].filter(Boolean).join("\n\n");

  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const body = new ReadableStream({
    async start(controller) {
      try {
        let emittedMeta = false;
        let emittedSectionCount = 0;
        let accumulated = "";

        // Stream LLM; after each token that closes a brace, check for newly complete sections/meta
        let summaryContent: string;
        try {
          summaryContent = await callDashScopeStream(systemPrompt, contextLines, apiKey, (token) => {
            accumulated += token;
            if (!token.includes("}")) return;

            if (!emittedMeta) {
              const meta = extractMeta(accumulated);
              if (meta) { controller.enqueue(send("meta", meta)); emittedMeta = true; }
            }

            const newSections = extractCompleteSections(accumulated, emittedSectionCount);
            for (const section of newSections) {
              controller.enqueue(send("section", section));
              emittedSectionCount++;
            }
          });
        } catch (e) {
          controller.enqueue(send("error", { error: String(e) }));
          controller.close();
          return;
        }

        // After stream ends: parse full JSON, emit any remaining sections
        let summary: unknown;
        try { summary = extractJSON(summaryContent); }
        catch {
          controller.enqueue(send("error", { error: "Failed to parse summary as JSON", raw: summaryContent }));
          controller.close();
          return;
        }

        const typedSummary = summary as Summary;

        // User-provided date takes priority over LLM-extracted date
        if (date) typedSummary.meta.date = date;

        // Emit remaining sections (last section + any missed)
        for (let i = emittedSectionCount; i < typedSummary.sections.length; i++) {
          controller.enqueue(send("section", typedSummary.sections[i]));
        }
        // Emit meta if not emitted yet (very short transcripts)
        if (!emittedMeta) {
          controller.enqueue(send("meta", typedSummary.meta));
        }

        // Persist meeting
        const today = new Date().toISOString().slice(0, 10);
        const meetingDate = date || typedSummary.meta.date || today;
        const meeting = await prisma.meeting.create({
          data: { user_id: userId, transcript: encrypt(transcript), summary: encryptJSON(typedSummary), project_id: project_id ?? null },
        });

        // Diff (project only)
        let document_diff: unknown = null;
        let document_diff_error: string | undefined;
        if (project) {
          try {
            const diffContent = await callDashScope(MEMORY_DIFF_PROMPT, `${langRule}\n\n会议日期：${meetingDate}\n\n当前项目主文档：\n${JSON.stringify(project.document, null, 2)}\n\n本次会议摘要：\n${JSON.stringify(typedSummary, null, 2)}\n\n请输出需要更新的字段及建议内容。`, apiKey);
            try { document_diff = extractJSON(diffContent); } catch { document_diff = null; }
          } catch (e) { document_diff_error = String(e); }
        }

        // Build & save chunks
        const summaryChunkInputs = buildSummaryChunks(typedSummary, meeting.id, project_id);
        const { chunks: transcriptChunkInputs, matchedLines, totalLines } =
          buildTranscriptChunks(transcript, meeting.id, project_id, typedSummary.meta.date ?? undefined);

        const formatOk = totalLines === 0 || matchedLines / totalLines >= 0.3;
        let chunks_warning: { matched_lines: number; total_lines: number } | undefined;
        if (!formatOk) {
          chunks_warning = { matched_lines: matchedLines, total_lines: totalLines };
          await prisma.processingLog.create({ data: { level: "warn", meeting_id: meeting.id, context: encryptJSON({ type: "transcript_format_mismatch", matched_lines: matchedLines, total_lines: totalLines }) } });
        }

        const chunksToInsert = formatOk ? [...summaryChunkInputs, ...transcriptChunkInputs] : summaryChunkInputs;
        const createdChunks = await Promise.all(chunksToInsert.map((c) => prisma.chunk.create({ data: { meeting_id: c.meeting_id, project_id: c.project_id, chunk_type: c.chunk_type, content: c.content, search_text: c.search_text, section_title: c.section_title, speaker: c.speaker, line_start: c.line_start, line_end: c.line_end, meeting_date: c.meeting_date } })));
        const chunksWithIds = createdChunks.map((c, i) => ({ ...chunksToInsert[i], id: c.id }));

        controller.enqueue(send("done", {
          meeting_id: meeting.id,
          summary,
          numbered_transcript: numbered,
          document_diff,
          ...(document_diff_error ? { document_diff_error } : {}),
          chunks_indexed: { summary: summaryChunkInputs.length, transcript: formatOk ? transcriptChunkInputs.length : 0 },
          ...(chunks_warning ? { chunks_warning } : {}),
        }));

        controller.close();
        const transcriptWithIds = chunksWithIds.filter(c => c.chunk_type === "transcript");
        embedAndStore(chunksWithIds, meeting.id, apiKey).catch(() => {});
        if (formatOk && transcriptWithIds.length > 0) {
          buildAndStoreParents(transcriptWithIds).catch(() => {});
        }

      } catch (e) {
        try { controller.enqueue(send("error", { error: String(e) })); controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
