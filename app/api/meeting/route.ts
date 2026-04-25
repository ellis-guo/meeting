import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { addLineNumbers } from "@/lib/utils";
import { encrypt, encryptJSON, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";

const RULES = `<rules>
1. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。
2. 仅记录会议中明确陈述或决定的内容；不推断态度、情绪或人物性格，不出现评判性表述（如"X 缺乏自信"或"此问题暴露了沟通不畅"）。
3. source_lines 必须引用原文中真实存在的行号，禁止虚构；每一条内容都必须附带 source_lines，不得为空数组。（source_lines 用于溯源功能，用户点击摘要内容时会跳转到对应原文行。）
4. 检测会议记录的主导语言，所有摘要文本使用该语言输出；若会议为多语言混合，以主导语言为准，但保留原文中出现的专业术语、学术词汇及专有名词。
5. 文本字段优先使用简洁短语而非完整句子，使用正式书面语，避免口语化或冗长表述。
</rules>`;

const CONTENT_TYPE_GUIDE = `<content_type_guide>
根据每个章节的内容选择最合适的类型：
- "text"：单段落或单条陈述（如会议概述、简短结论）
- "bullets"：多个独立要点；每条 bullet 可选包含 sub_items 用于嵌套细节
- "table"：内容具有清晰统一的列结构时使用（如 负责人 / 任务 / 截止日期）；仅当所有行共享相同列结构时才使用

重要：sub_items 为可选字段，当一个要点包含多个独立子内容时使用，禁止用分号将其合并为一条。

各类型 Schema：
  { "type": "text", "value": "string", "source_lines": [number] }
  { "type": "bullets", "items": [{ "text": "string", "source_lines": [number], "sub_items": [{ "text": "string", "source_lines": [number] }] }] }
  { "type": "table", "columns": ["string"], "rows": [{ "cells": ["string"], "source_lines": [number] }] }
</content_type_guide>`;

const SHARED_SCHEMA = `<schema>
{
  "meta": {
    "date": "string or null",
    "time": "string or null",
    "participants": ["string"]
  },
  "sections": [
    {
      "title": "string",
      "content": <以上三种内容类型之一>
    }
  ],
  "humanistic_note": "string or null"
}
</schema>`;

const HUMANISTIC_NOTE_RULE = `- humanistic_note：仅当会议中有人明确、反复提到身体不适（生病、头疼、发烧等）或明显沮丧（想哭、很难过、崩溃等）时触发，门槛要高，模糊信号一律返回 null。触发时用一句15字以内的话表达简单关心或祝福；绝对不提情绪本身、不做任何情绪分析、不贴标签；否则为 null。`;

const SUMMARY_SMART_PROMPT = `你是一位专业的会议记录助手，擅长从口语化的会议记录中提炼关键信息，以结构化、正式书面语的方式输出会议摘要。

${RULES}

${CONTENT_TYPE_GUIDE}

${SHARED_SCHEMA}

<instructions>
- meta.date：从会议记录或上下文中提取日期，若未提及则为 null
- meta.time：从会议记录中提取会议开始时间，若未提及则为 null
- meta.participants：提取会议记录中出现的所有发言者姓名
- sections：根据会议内容自行决定章节组合与顺序。以下为候选章节，按触发条件决定是否包含：

  <candidate_sections>
  • 会议背景 — 仅当有明确的召开原因或背景信息时包含；"text" 类型，一句话
  • 讨论要点 — 核心章节，几乎必含；完整呈现各议题的内容与各方观点；用 sub_items 拆解多要点议题，禁止用分号合并独立要点；应为摘要中最长、最详细的章节
  • 关键决策 — 仅当会议中有明确拍板的结论时包含；"bullets" 类型，每条一个决策
    示例：{ "text": "确认采用方案 B，预计下周一上线", "source_lines": [42, 43] }
  • 行动项 — 仅当有具体任务被分配时包含；有统一"负责人/任务/截止时间"结构时用 "table"，否则用 "bullets"；任务描述须含负责人，截止时间若提及则记录
    示例（table）：{ "columns": ["负责人", "任务", "截止时间"], "rows": [{ "cells": ["张三", "整理需求文档", "本周五"], "source_lines": [67] }] }
  • 遗留问题 — 仅当有明确未解决、需后续跟进的问题时包含；"bullets" 类型
  • 下次会议 — 仅当会议中提及时包含；"text" 类型
  </candidate_sections>

  章节标题可自定义，也可增加候选清单之外的章节。

${HUMANISTIC_NOTE_RULE}
</instructions>`;

const SUMMARY_PROGRESS_PROMPT = `你是一位专业的会议记录助手，擅长从口语化的项目进度会议记录中提炼关键信息，以结构化、正式书面语的方式输出会议摘要。

${RULES}

${CONTENT_TYPE_GUIDE}

${SHARED_SCHEMA}

<instructions>
- 若 context 中包含 <project_context>，将其作为背景参考以理解成员角色、项目术语和当前状态；摘要内容须以本次会议记录为准。
- meta.date：优先使用 context 中提供的会议日期；若未提供则从会议记录中提取，仍未找到则为 null
- meta.time：从会议记录中提取会议开始时间，若未提及则为 null
- meta.participants：提取会议记录中出现的所有发言者姓名
- sections：须包含以下章节（确实不适用时可跳过）：
    1. 会议概述 — "text" 类型；一段简短概括
    2. 议题详情 — 最重要的章节；"bullets" 类型；涵盖每个讨论议题的完整细节；用 sub_items 拆解多要点议题；禁止用分号合并独立要点
    3. 关键决策 — 仅当会议中有明确拍板的结论时包含；"bullets" 类型，每条一个决策
    4. 行动项 — 若所有条目具有统一的负责人/任务结构则用 "table"，否则用 "bullets"；任务描述须含负责人，截止时间若提及则记录
    5. 遗留问题 — 仅当有明确未解决、需后续跟进的问题时包含；"bullets" 类型
    6. 下次会议 — "text" 类型；仅在会议中提及时包含
    7. 其他 — "text" 类型；仅在有其他内容时包含
  如有必要可增加额外章节。
- 议题详情 应为摘要中最长、最详细的章节

${HUMANISTIC_NOTE_RULE}
</instructions>`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON found");
  return JSON.parse(text.slice(start, end + 1));
}

const MEMORY_DIFF_PROMPT = `你是一位专业的项目文档维护助手。根据本次会议摘要，分析项目主文档中哪些内容需要更新，输出差量更新建议。

<rules>
1. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。
2. 仅基于本次会议摘要中明确提及的内容提出更新建议，不推断。
3. key_decisions 只能新增，不能修改或删除已有条目。
4. open_issues 可新增（新问题）或移除（已解决问题），new 值为完整的新数组。
5. checklist：仅可将已完成的条目 status 从 "pending" 改为 "done"，不得新增或删除条目；new 值为完整的新数组。
6. 若本次会议无需更新某字段，不要在 updates 中包含该字段。
7. 每条建议须附带 reason，说明依据来自会议的哪部分内容，≤20字。
8. key_decisions 新增条目的 date 以及 current_progress.as_of，必须使用 context 中提供的会议日期，格式 YYYY-MM-DD。
9. 极度压缩：所有字段内容保持短语级别，与主文档整体风格一致。
</rules>

<schema>
{
  "updates": [
    {
      "field": "overview | goals | members | milestones | current_progress | key_decisions | open_issues | risks | glossary | checklist | next_meeting_goals",
      "old": <原值>,
      "new": <新值，current_progress 必须严格为 {"summary":"string","as_of":"YYYY-MM-DD"} 格式，不得添加其他字段>,
      "reason": "string"
    }
  ]
}
</schema>`;

async function callDashScope(systemPrompt: string, userMessage: string, apiKey: string): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        enable_thinking: false,
      }),
    },
  );
  if (!res.ok) throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return content;
}

async function callDashScopeStream(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
  onToken: (text: string) => void,
): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        enable_thinking: false,
        stream: true,
      }),
    },
  );
  if (!res.ok) throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk: string = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? "";
        if (chunk) { fullText += chunk; onToken(chunk); }
      } catch { /* skip */ }
    }
  }
  return fullText;
}

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

type SectionContent =
  | { type: "text"; value: string; source_lines: number[] }
  | { type: "bullets"; items: Array<{ text: string; source_lines: number[]; sub_items?: Array<{ text: string; source_lines: number[] }> }> }
  | { type: "table"; columns: string[]; rows: Array<{ cells: string[]; source_lines: number[] }> };
type Section = { title: string; content: SectionContent };
type Summary = {
  meta: { date: string | null; time: string | null; participants: string[] };
  sections: Section[];
  humanistic_note: string | null;
};

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

// ── Chunk building ────────────────────────────────────────────────────────────
type ChunkInput = {
  meeting_id: string; project_id: string | null; chunk_type: string;
  content: string; search_text: string | null; section_title: string | null;
  speaker: string | null; line_start: number | null; line_end: number | null; meeting_date: string | null;
};

function renderSectionText(section: Section): string {
  const c = section.content;
  if (c.type === "text") return c.value;
  if (c.type === "bullets") return c.items.map((item) => {
    const subs = item.sub_items?.map((s) => `  - ${s.text}`).join("\n") ?? "";
    return subs ? `- ${item.text}\n${subs}` : `- ${item.text}`;
  }).join("\n");
  return `${c.columns.join(" | ")}\n${c.rows.map((r) => r.cells.join(" | ")).join("\n")}`;
}

function collectSourceLines(section: Section): number[] {
  const c = section.content;
  const safe = (v: unknown): number[] => Array.isArray(v) ? (v as number[]) : [];
  if (c.type === "text") return safe(c.source_lines);
  if (c.type === "bullets") return c.items.flatMap((i) => [
    ...safe(i.source_lines),
    ...(i.sub_items?.flatMap((s) => safe(s.source_lines)) ?? []),
  ]);
  return c.rows.flatMap((r) => safe(r.source_lines));
}

function buildSummaryChunks(summary: Summary, meetingId: string, projectId?: string): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  for (const section of summary.sections) {
    const c = section.content;
    if (section.title === "议题详情" && c.type === "bullets" && c.items.length >= 2) {
      for (const item of c.items) {
        const subText = item.sub_items?.map((s) => `  - ${s.text}`).join("\n") ?? "";
        const itemText = subText ? `- ${item.text}\n${subText}` : `- ${item.text}`;
        const plainText = `${section.title}\n${itemText}`;
        const lines = [
          ...item.source_lines,
          ...(item.sub_items?.flatMap((s) => s.source_lines) ?? []),
        ];
        chunks.push({
          meeting_id: meetingId, project_id: projectId ?? null, chunk_type: "summary",
          content: plainText, search_text: plainText, section_title: section.title,
          speaker: null,
          line_start: lines.length ? Math.min(...lines) : null,
          line_end: lines.length ? Math.max(...lines) : null,
          meeting_date: summary.meta.date ?? null,
        });
      }
    } else {
      const plainText = `${section.title}\n${renderSectionText(section)}`;
      const lines = collectSourceLines(section);
      chunks.push({
        meeting_id: meetingId, project_id: projectId ?? null, chunk_type: "summary",
        content: plainText, search_text: plainText, section_title: section.title,
        speaker: null,
        line_start: lines.length ? Math.min(...lines) : null,
        line_end: lines.length ? Math.max(...lines) : null,
        meeting_date: summary.meta.date ?? null,
      });
    }
  }
  return chunks;
}

const TENCENT_TURN = /^(.+?)\((\d{2}:\d{2}:\d{2})\):\s*(.+)/;
type Turn = { speaker: string; text: string; lineStart: number; lineEnd: number };

function mergeShortTurns(turns: Turn[], maxChars: number): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === turn.speaker && last.text.length + turn.text.length < maxChars) {
      last.text += "　" + turn.text; last.lineEnd = turn.lineEnd;
    } else { merged.push({ ...turn }); }
  }
  return merged;
}

function buildTranscriptChunks(transcript: string, meetingId: string, projectId?: string, meetingDate?: string) {
  const lines = transcript.split("\n").filter((l) => l.trim());
  const turns: Turn[] = [];
  let matchedLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TENCENT_TURN);
    if (m) { matchedLines++; turns.push({ speaker: m[1].trim(), text: m[3].trim(), lineStart: i + 1, lineEnd: i + 1 }); }
  }
  const merged = mergeShortTurns(turns, 200);
  const chunks: ChunkInput[] = merged.map((turn) => {
    const plainText = `${turn.speaker}：${turn.text}`;
    return { meeting_id: meetingId, project_id: projectId ?? null, chunk_type: "transcript", content: plainText, search_text: plainText, section_title: null, speaker: turn.speaker, line_start: turn.lineStart, line_end: turn.lineEnd, meeting_date: meetingDate ?? null };
  });
  return { chunks, matchedLines, totalLines: lines.length };
}

// ── Embedding ────────────────────────────────────────────────────────────────
async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-v3", input: texts, dimension: 1024 }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} — ${await res.text()}`);
  return ((await res.json()).data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

async function embedAndStore(chunks: Array<ChunkInput & { id: string }>, meetingId: string, apiKey: string) {
  const BATCH = 10;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    let vectors: number[][];
    try { vectors = await fetchEmbeddings(batch.map((c) => c.content), apiKey); }
    catch (e) {
      await prisma.processingLog.create({ data: { level: "error", meeting_id: meetingId, context: encryptJSON({ type: "embedding_batch_failed", batch_start: i, detail: String(e) }) } });
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = `[${vectors[j].join(",")}]`;
      try { await prisma.$executeRaw`UPDATE "Chunk" SET embedding = ${vec}::vector WHERE id = ${batch[j].id}`; }
      catch (e) { await prisma.processingLog.create({ data: { level: "error", meeting_id: meetingId, context: encryptJSON({ type: "embedding_write_failed", chunk_id: batch[j].id, detail: String(e) }) } }); }
    }
  }
}

const PARENT_WINDOW = 4;

async function buildAndStoreParents(transcriptChunks: Array<ChunkInput & { id: string }>): Promise<void> {
  for (let i = 0; i < transcriptChunks.length; i += PARENT_WINDOW) {
    const group = transcriptChunks.slice(i, i + PARENT_WINDOW);
    const content = group.map(c => c.search_text ?? c.content).join("\n");
    const uniqueSpeakers = [...new Set(group.flatMap(c => c.speaker ? [c.speaker] : []))];
    const speakers = uniqueSpeakers.join(" | ") || "未知";
    const parentId = crypto.randomUUID();
    const meetingId = group[0].meeting_id;
    const projectId = group[0].project_id ?? null;
    const meetingDate = group[0].meeting_date ?? null;
    const lineStart = group[0].line_start ?? null;
    const lineEnd = group[group.length - 1].line_end ?? null;
    try {
      await prisma.$executeRaw`
        INSERT INTO "ChunkParent" (id, meeting_id, project_id, meeting_date, content, speakers, line_start, line_end)
        VALUES (${parentId}, ${meetingId}, ${projectId}, ${meetingDate}, ${content}, ${speakers}, ${lineStart}, ${lineEnd})
      `;
      for (const chunk of group) {
        await prisma.$executeRaw`UPDATE "Chunk" SET parent_id = ${parentId} WHERE id = ${chunk.id}`;
      }
    } catch (e) {
      await prisma.processingLog.create({
        data: { level: "error", meeting_id: meetingId, context: encryptJSON({ type: "parent_creation_failed", window_start: i, detail: String(e) }) },
      });
    }
  }
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
