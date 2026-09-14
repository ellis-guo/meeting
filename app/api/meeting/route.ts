import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { addLineNumbers, extractJSON } from "@/lib/utils";
import { encrypt, encryptJSON, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { callDashScopeStream, FAST_CHAT_MODEL } from "@/lib/dashscope";
import { SUMMARY_SMART_PROMPT, SUMMARY_PROGRESS_PROMPT } from "@/lib/prompts";
import {
  type Section, type Summary,
  buildSummaryChunks, buildTranscriptChunks, insertChunks,
} from "@/lib/chunking";
import { enqueue } from "@/lib/jobs";
import { startBackgroundDrain } from "@/lib/jobRunner";
import { registerJobHandlers } from "@/lib/registerJobs";
import { checkRateLimit } from "@/lib/ratelimit";
import { markIndexDirty } from "@/lib/dreaming";
import { getLangRule } from "@/lib/lang";
import { SSE_HEADERS, sseFrame as send } from "@/lib/sse";

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

  if (project_id) {
    const owned = await prisma.project.findFirst({
      where: { id: project_id, user_id: userId },
      select: { id: true },
    });
    if (!owned) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const numbered = addLineNumbers(transcript);
  const systemPrompt = template === "project" ? SUMMARY_PROGRESS_PROMPT : SUMMARY_SMART_PROMPT;
  // 主文档不再作为 <project_context> 喂进来：它已经不被任何流程更新了，
  // 继续喂等于让模型参考一份只会越来越旧的东西（PRD 4.5）。
  const contextLines = [
    langRule,
    date ? `会议日期：${date}` : null,
    time ? `会议时间：${time}` : null,
    `以下是会议记录：\n\n${numbered}`,
  ].filter(Boolean).join("\n\n");

  const body = new ReadableStream({
    async start(controller) {
      try {
        let emittedMeta = false;
        let emittedSectionCount = 0;
        let accumulated = "";

        // Stream LLM; after each token that closes a brace, check for newly complete sections/meta
        let summaryContent: string;
        try {
          // 第 5 个参数 sep 必须显式传 ""——model 排在它后面，漏了会静默用回默认模型
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
          }, "", FAST_CHAT_MODEL)).fullText;
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

        // 项目多了一场会议 → 索引层过期，等 dreaming 重算
        await markIndexDirty(project_id);

        // Build & save chunks (synchronous so the user can rely on summary
        // sources immediately after `done`)
        // 顺序有意：totalLines 由逐字稿切分算出（过滤空行后从 1 开始，和喂给
        // 模型的 addLineNumbers 同一基准），summary 的 source_lines 要按它校验。
        const { chunks: transcriptChunkInputs, matchedLines, totalLines } =
          buildTranscriptChunks(transcript, meeting.id, project_id, meetingDate);
        const { chunks: summaryChunkInputs, droppedLines } =
          buildSummaryChunks(typedSummary, meeting.id, project_id, totalLines);

        const formatOk = totalLines === 0 || matchedLines / totalLines >= 0.3;
        let chunks_warning: { matched_lines: number; total_lines: number } | undefined;
        if (!formatOk) {
          chunks_warning = { matched_lines: matchedLines, total_lines: totalLines };
          await prisma.processingLog.create({ data: { level: "warn", meeting_id: meeting.id, context: encryptJSON({ type: "transcript_format_mismatch", matched_lines: matchedLines, total_lines: totalLines }) } });
        }

        // 模型报了原文里不存在的行号。锚点已被丢弃（宁可没有也不要错的），
        // 但要留痕：这是 prompt 质量的直接信号，静默丢掉就再也发现不了。
        if (droppedLines > 0) {
          await prisma.processingLog.create({ data: { level: "warn", meeting_id: meeting.id, context: encryptJSON({ type: "source_lines_out_of_range", dropped: droppedLines, total_lines: totalLines }) } }).catch(() => {});
        }

        const chunksToInsert = formatOk ? [...summaryChunkInputs, ...transcriptChunkInputs] : summaryChunkInputs;
        // insertChunks 走一次 createMany（id 在客户端生成）。原来是每条一个
        // prisma.chunk.create，一场会议几百条就是几百个来回。
        await insertChunks(chunksToInsert);

        // SSE done：摘要和 chunk 都已落库，向量由后台 reindex 任务补齐
        controller.enqueue(send("done", {
          meeting_id: meeting.id,
          summary,
          numbered_transcript: numbered,
          chunks_indexed: { summary: summaryChunkInputs.length, transcript: formatOk ? transcriptChunkInputs.length : 0 },
          ...(chunks_warning ? { chunks_warning } : {}),
        }));

        controller.close();

        // ── Background tasks (don't depend on SSE connection) ────────────────
        //
        // 向量化和父块构建走任务队列，不再是裸 fire-and-forget。
        //
        // 原来是 `embedAndStore(...).catch(() => {})`：SSE 一关、进程一重启，
        // 这活就静默消失了，chunk 留在库里永远没有向量。而所有向量检索都带
        // `embedding IS NOT NULL`——那不是"慢一点"，是**这场会议从此检索不到**，
        // 界面上还完全看不出来。进了队列就有重试、有记录、崩了能被 reclaimStale
        // 捡回来（见 lib/jobs.ts 开头）。
        //
        // 处理函数按"缺什么补什么"补向量，所以这里不用把 chunk 列表传过去，
        // 重试也不会重复付费。
        registerJobHandlers();
        await enqueue({
          userId,
          projectId: project_id ?? null,
          type: "reindex",
          payload: { meetingId: meeting.id, mode: "initial" },
        });
        // 立刻在后台开跑，不等下一次 tick——tick 是每小时一次的兜底
        startBackgroundDrain();

        // 摘要、chunk、向量任务都安排好了，这场会议就算处理完了。
        //
        // 原来这里还挂着一大段"生成主文档更新建议 → 写 document_diff → 发通知
        // 让用户确认"。整套随主文档一起下线了（PRD 4.5/5.2）：主文档降级成
        // 索引层之后不呈现、不检索、不引用，也就没有什么需要用户确认的。
        // 顺带省掉了每场会议一次 LLM 调用。
        await prisma.meeting
          .update({ where: { id: meeting.id }, data: { processing_status: "done" } })
          .catch(() => {});

      } catch (e) {
        try { controller.enqueue(send("error", { error: String(e) })); controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(body, { headers: SSE_HEADERS });
}
