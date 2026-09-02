import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { addLineNumbers, extractJSON } from "@/lib/utils";
import { encrypt, encryptJSON, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { callDashScope, callDashScopeStream } from "@/lib/dashscope";
import { SUMMARY_SMART_PROMPT, SUMMARY_PROGRESS_PROMPT, MEMORY_DIFF_PROMPT } from "@/lib/prompts";
import { validateDiff } from "@/lib/projectDocSchema";
import {
  type Section, type Summary,
  buildSummaryChunks, buildTranscriptChunks, embedAndStore, buildAndStoreParents,
} from "@/lib/chunking";
import { checkRateLimit } from "@/lib/ratelimit";
import { getLangRule } from "@/lib/lang";

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

  const rl = checkRateLimit(userId, "POST:/api/meeting");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试（每分钟最多 5 次）" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) return NextResponse.json({ error: "API key required. Please configure your DashScope API key in Settings." }, { status: 401 });

  const langRule = getLangRule(req);

  const { transcript, template = "smart", date, time, project_id } = await req.json();
  if (!transcript?.trim()) return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  if (transcript.length > 200_000) return NextResponse.json({ error: "transcript too large (max 200KB)" }, { status: 400 });

  let project: { id: string; name: string; document: unknown; no_document: boolean } | null = null;
  if (project_id) {
    const raw = await prisma.project.findFirst({ where: { id: project_id, user_id: userId } });
    if (!raw) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    project = { id: raw.id, name: raw.name, document: raw.document ? decryptJSON(raw.document) : {}, no_document: raw.no_document };
  }

  const numbered = addLineNumbers(transcript);
  const systemPrompt = template === "project" ? SUMMARY_PROGRESS_PROMPT : SUMMARY_SMART_PROMPT;
  // no_document 项目没有主文档，塞空对象只会给模型噪音
  const hasProjectDoc =
    !!project && !project.no_document &&
    Object.keys(project.document as Record<string, unknown>).length > 0;
  const contextLines = [
    langRule,
    hasProjectDoc ? `<project_context>\n${JSON.stringify(project!.document)}\n</project_context>` : null,
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
          summaryContent = (await callDashScopeStream(systemPrompt, contextLines, apiKey, (token) => {
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
          })).fullText;
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

        // 模型偶发漏字段（缺 meta / sections 不是数组），下面所有代码都假设它们存在，
        // 这里显式兜底，避免直接抛 TypeError 把整条 SSE 打断成一句 [object Object]
        if (!typedSummary.meta || typeof typedSummary.meta !== "object") {
          typedSummary.meta = { date: null, time: null, participants: [] };
        }
        if (!Array.isArray(typedSummary.meta.participants)) typedSummary.meta.participants = [];
        if (!Array.isArray(typedSummary.sections)) {
          controller.enqueue(send("error", { error: "模型返回的摘要缺少 sections，请重试", raw: summaryContent.slice(0, 2000) }));
          controller.close();
          return;
        }

        // 会议日期唯一真源：用户输入 > 模型抽取 > 今天。
        // 必须写回 meta.date —— buildSummaryChunks / buildTranscriptChunks 都从这里取
        // chunk.meeting_date，留 null 会让这些 chunk 对所有日期过滤检索不可见。
        const today = new Date().toISOString().slice(0, 10);
        const meetingDate = date || typedSummary.meta.date || today;
        typedSummary.meta.date = meetingDate;

        // Emit remaining sections (last section + any missed)
        for (let i = emittedSectionCount; i < typedSummary.sections.length; i++) {
          controller.enqueue(send("section", typedSummary.sections[i]));
        }
        // Emit meta if not emitted yet (very short transcripts)
        if (!emittedMeta) {
          controller.enqueue(send("meta", typedSummary.meta));
        }

        // Persist meeting (initial status: processing)
        const meeting = await prisma.meeting.create({
          data: {
            user_id: userId,
            transcript: encrypt(transcript),
            summary: encryptJSON(typedSummary),
            project_id: project_id ?? null,
            processing_status: "processing",
          },
        });

        // Build & save chunks (synchronous so the user can rely on summary
        // sources immediately after `done`)
        const summaryChunkInputs = buildSummaryChunks(typedSummary, meeting.id, project_id);
        const { chunks: transcriptChunkInputs, matchedLines, totalLines } =
          buildTranscriptChunks(transcript, meeting.id, project_id, meetingDate);

        const formatOk = totalLines === 0 || matchedLines / totalLines >= 0.3;
        let chunks_warning: { matched_lines: number; total_lines: number } | undefined;
        if (!formatOk) {
          chunks_warning = { matched_lines: matchedLines, total_lines: totalLines };
          await prisma.processingLog.create({ data: { level: "warn", meeting_id: meeting.id, context: encryptJSON({ type: "transcript_format_mismatch", matched_lines: matchedLines, total_lines: totalLines }) } });
        }

        const chunksToInsert = formatOk ? [...summaryChunkInputs, ...transcriptChunkInputs] : summaryChunkInputs;
        const createdChunks = await Promise.all(chunksToInsert.map((c) => prisma.chunk.create({ data: { meeting_id: c.meeting_id, project_id: c.project_id, chunk_type: c.chunk_type, content: c.content, search_text: c.search_text, section_title: c.section_title, speaker: c.speaker, line_start: c.line_start, line_end: c.line_end, meeting_date: c.meeting_date } })));
        const chunksWithIds = createdChunks.map((c, i) => ({ ...chunksToInsert[i], id: c.id }));

        // SSE done — diff is no longer in payload (will land asynchronously
        // into Meeting.document_diff and surface via Notification)
        controller.enqueue(send("done", {
          meeting_id: meeting.id,
          summary,
          numbered_transcript: numbered,
          chunks_indexed: { summary: summaryChunkInputs.length, transcript: formatOk ? transcriptChunkInputs.length : 0 },
          ...(chunks_warning ? { chunks_warning } : {}),
        }));

        controller.close();

        // ── Background tasks (don't depend on SSE connection) ────────────────
        const transcriptWithIds = chunksWithIds.filter(c => c.chunk_type === "transcript");
        embedAndStore(chunksWithIds, meeting.id, apiKey).catch(() => {});
        if (formatOk && transcriptWithIds.length > 0) {
          buildAndStoreParents(transcriptWithIds).catch(() => {});
        }

        if (project && !project.no_document) {
          // Project meetings: generate diff in background, retry once on
          // failure, then either persist diff + notify or persist failure +
          // notify so the user can recover.
          (async () => {
            const projectForDiff = project;
            const diffPrompt = `${langRule}\n\n会议日期：${meetingDate}\n\n当前项目主文档：\n${JSON.stringify(projectForDiff.document, null, 2)}\n\n本次会议摘要：\n${JSON.stringify(typedSummary, null, 2)}\n\n请输出需要更新的字段及建议内容。`;

            // 一次完整尝试 = 调 LLM + extractJSON + schema 校验。
            // 任一步失败均视作失败，进入下一次重试。
            const tryGenerate = async (): Promise<unknown> => {
              const raw = (await callDashScope(MEMORY_DIFF_PROMPT, diffPrompt, apiKey)).content;
              const parsed = extractJSON(raw);
              const err = validateDiff(parsed);
              if (err) throw new Error(`Diff schema invalid: ${err}`);
              return parsed;
            };

            let document_diff: unknown = null;
            let lastError: unknown = null;
            // 总共 3 次尝试：原始 + 2 次重试
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                document_diff = await tryGenerate();
                lastError = null;
                break;
              } catch (e) {
                lastError = e;
                if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
              }
            }

            if (document_diff) {
              await prisma.meeting.update({
                where: { id: meeting.id },
                data: {
                  document_diff: encryptJSON(document_diff),
                  diff_status: "pending",
                  processing_status: "done",
                },
              }).catch(() => {});
              await prisma.notification.create({
                data: {
                  user_id: userId,
                  type: "diff_pending",
                  title: "主文档更新待处理",
                  body: `项目「${projectForDiff.name}」生成了新的主文档更新建议，待你确认。`,
                  link: `/projects/${projectForDiff.id}/meetings/${meeting.id}?diff=1`,
                },
              }).catch(() => {});
            } else {
              await prisma.meeting.update({
                where: { id: meeting.id },
                data: { processing_status: "failed" },
              }).catch(() => {});
              await prisma.processingLog.create({
                data: {
                  level: "error",
                  meeting_id: meeting.id,
                  context: encryptJSON({ type: "diff_generation_failed", error: String(lastError) }),
                },
              }).catch(() => {});
              await prisma.notification.create({
                data: {
                  user_id: userId,
                  type: "diff_failed",
                  title: "主文档更新生成失败",
                  body: `项目「${projectForDiff.name}」的会议摘要已保存，但主文档更新建议生成失败，可在会议页重试。`,
                  link: `/projects/${projectForDiff.id}/meetings/${meeting.id}?diff=1`,
                },
              }).catch(() => {});
            }
          })().catch(async (err) => {
            // 兜底：IIFE 内同步抛出的异常（如 encryptJSON 失败）不会被上面的
            // 逐条 .catch() 接住，未捕获的 rejection 在 Node 默认配置下会杀进程。
            await prisma.meeting
              .update({ where: { id: meeting.id }, data: { processing_status: "failed" } })
              .catch(() => {});
            await prisma.processingLog
              .create({
                data: {
                  level: "error",
                  meeting_id: meeting.id,
                  context: encryptJSON({ type: "diff_task_crashed", error: String(err) }),
                },
              })
              .catch(() => {});
          });
        } else {
          // Standalone meeting: nothing more to do, mark done.
          prisma.meeting.update({
            where: { id: meeting.id },
            data: { processing_status: "done" },
          }).catch(() => {});
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
