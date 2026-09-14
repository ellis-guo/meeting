import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";
import { fetchEmbeddings } from "@/lib/dashscope";
import { numberedLines } from "@/lib/utils";

export const PARENT_WINDOW = 5;

export type SectionContent =
  | { type: "text"; value: string; source_lines: number[] }
  | { type: "bullets"; items: Array<{ text: string; source_lines: number[]; sub_items?: Array<{ text: string; source_lines: number[] }> }> }
  | { type: "table"; columns: string[]; rows: Array<{ cells: string[]; source_lines: number[] }> };

export type Section = { title: string; content: SectionContent };

/** 线上 / 线下。判不出来就是 null——见 prompts.ts 里那条「不要猜」。 */
export type Modality = "online" | "offline";

export type Summary = {
  meta: {
    date: string | null;
    time: string | null;
    participants: string[];
    /**
     * 2026-09-14 才加的两个字段，**存量会议没有**。可选不是偷懒：
     * 渲染处必须能接受 undefined，不能拿日期或"未命名会议"顶上去。
     * ⚠️ app/types.ts 里还有一份给前端用的 Summary，改这里记得一起改。
     */
    title?: string | null;
    modality?: Modality | null;
  };
  sections: Section[];
  humanistic_note: string | null;
};

export type ChunkInput = {
  // 来源二选一：会议，或参考文件。两个都为 null 的 chunk 没有出处，不该存在。
  meeting_id: string | null;
  reference_doc_id: string | null;
  project_id: string | null;
  chunk_type: string;
  content: string;
  search_text: string | null;
  section_title: string | null;
  speaker: string | null;
  line_start: number | null;
  line_end: number | null;
  meeting_date: string | null;
};

type Turn = { speaker: string; text: string; lineStart: number; lineEnd: number };

function renderSectionText(section: Section): string {
  const c = section.content;
  if (c.type === "text") return c.value;
  if (c.type === "bullets") return c.items.map((item) => {
    const subs = item.sub_items?.map((s) => `  - ${s.text}`).join("\n") ?? "";
    return subs ? `- ${item.text}\n${subs}` : `- ${item.text}`;
  }).join("\n");
  return `${c.columns.join(" | ")}\n${c.rows.map((r) => r.cells.join(" | ")).join("\n")}`;
}

/** 一个 section 里所有 source_lines 数组的原样集合（未校验）。 */
function sectionRawLines(section: Section): unknown[] {
  const c = section.content;
  if (c.type === "text") return [c.source_lines];
  if (c.type === "bullets") return c.items.flatMap((i) => [
    i.source_lines,
    ...(i.sub_items?.map((s) => s.source_lines) ?? []),
  ]);
  return c.rows.map((r) => r.source_lines);
}

/**
 * 校验模型给出的 source_lines，只保留 1..totalLines 范围内的整数。
 *
 * prompts.ts 的 RULES 第 3 条写着"必须引用原文中真实存在的行号，禁止虚构"，
 * 但那是祈使句、不是校验。模型报一个越界行号时，下面的 Math.min/max 会把它
 * 原样写进 line_start，溯源浮窗跳到空处——而界面上它和正确的锚点长得一模一样，
 * 用户没有任何办法分辨。宁可没有锚点（前端已按 line_start == null 降级成不可
 * 点击），也不要一个错的锚点。
 *
 * totalLines 传 null = 拿不到逐字稿（解密失败等），跳过越界校验：把本来正确的
 * 锚点全清掉比留着更糟。非整数、<1 的值在任何情况下都丢弃。
 */
function pickLines(raws: unknown[], totalLines: number | null): { lines: number[]; dropped: number } {
  const lines: number[] = [];
  let dropped = 0;
  for (const raw of raws) {
    if (!Array.isArray(raw)) continue;
    for (const v of raw) {
      // 模型偶发把行号写成字符串 "42"；真正的垃圾会变成 NaN，一并计入 dropped
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= 1 && (totalLines === null || n <= totalLines)) lines.push(n);
      else dropped++;
    }
  }
  return { lines, dropped };
}

/**
 * 摘要 → chunks。totalLines 是 source_lines 的校验基准，见 pickLines；
 * 返回的 droppedLines 是被丢弃的越界/非法行号个数，调用方负责记日志。
 */
export function buildSummaryChunks(
  summary: Summary,
  meetingId: string,
  projectId: string | undefined,
  totalLines: number | null,
): { chunks: ChunkInput[]; droppedLines: number } {
  const chunks: ChunkInput[] = [];
  let droppedLines = 0;
  for (const section of summary.sections) {
    const c = section.content;
    if (section.title === "议题详情" && c.type === "bullets" && c.items.length >= 2) {
      for (const item of c.items) {
        const subText = item.sub_items?.map((s) => `  - ${s.text}`).join("\n") ?? "";
        const itemText = subText ? `- ${item.text}\n${subText}` : `- ${item.text}`;
        const plainText = `${section.title}\n${itemText}`;
        const { lines, dropped } = pickLines([
          item.source_lines,
          ...(item.sub_items?.map((s) => s.source_lines) ?? []),
        ], totalLines);
        droppedLines += dropped;
        chunks.push({
          meeting_id: meetingId, reference_doc_id: null, project_id: projectId ?? null, chunk_type: "summary",
          content: plainText, search_text: plainText, section_title: section.title,
          speaker: null,
          line_start: lines.length ? Math.min(...lines) : null,
          line_end: lines.length ? Math.max(...lines) : null,
          meeting_date: summary.meta.date ?? null,
        });
      }
    } else {
      const plainText = `${section.title}\n${renderSectionText(section)}`;
      const { lines, dropped } = pickLines(sectionRawLines(section), totalLines);
      droppedLines += dropped;
      chunks.push({
        meeting_id: meetingId, reference_doc_id: null, project_id: projectId ?? null, chunk_type: "summary",
        content: plainText, search_text: plainText, section_title: section.title,
        speaker: null,
        line_start: lines.length ? Math.min(...lines) : null,
        line_end: lines.length ? Math.max(...lines) : null,
        meeting_date: summary.meta.date ?? null,
      });
    }
  }
  return { chunks, droppedLines };
}

const TENCENT_TURN = /^(.+?)\((\d{2}:\d{2}:\d{2})\):\s*(.+)/;

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

export function buildTranscriptChunks(
  transcript: string,
  meetingId: string,
  projectId?: string,
  meetingDate?: string,
): { chunks: ChunkInput[]; matchedLines: number; totalLines: number } {
  const lines = numberedLines(transcript);
  const turns: Turn[] = [];
  let matchedLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TENCENT_TURN);
    if (m) {
      matchedLines++;
      turns.push({ speaker: m[1].trim(), text: m[3].trim(), lineStart: i + 1, lineEnd: i + 1 });
    }
  }
  const merged = mergeShortTurns(turns, 200);
  const chunks: ChunkInput[] = merged.map((turn) => {
    const plainText = `${turn.speaker}：${turn.text}`;
    return {
      meeting_id: meetingId, reference_doc_id: null, project_id: projectId ?? null, chunk_type: "transcript",
      content: plainText, search_text: plainText, section_title: null,
      speaker: turn.speaker, line_start: turn.lineStart, line_end: turn.lineEnd,
      meeting_date: meetingDate ?? null,
    };
  });
  return { chunks, matchedLines, totalLines: lines.length };
}

export { fetchEmbeddings };

/**
 * 批量落库并回填 id。
 * id 在客户端生成而不是依赖 DB 默认值，这样一次 createMany 就能确定每条 chunk 的 id，
 * 既不用 N 次 create（一次会议几百条 = 几百个来回），也不用假设 RETURNING 的行序。
 */
export async function insertChunks(
  inputs: ChunkInput[],
): Promise<Array<ChunkInput & { id: string }>> {
  if (inputs.length === 0) return [];
  const withIds = inputs.map((c) => ({ ...c, id: crypto.randomUUID() }));
  await prisma.chunk.createMany({
    data: withIds.map((c) => ({
      id: c.id,
      meeting_id: c.meeting_id,
      reference_doc_id: c.reference_doc_id,
      project_id: c.project_id,
      chunk_type: c.chunk_type,
      content: c.content,
      search_text: c.search_text,
      section_title: c.section_title,
      speaker: c.speaker,
      line_start: c.line_start,
      line_end: c.line_end,
      meeting_date: c.meeting_date,
    })),
  });
  return withIds;
}

/**
 * 摘要被编辑后重建 summary chunks（transcript chunks 不受影响，保持原样）。
 * 不重建的话，检索命中的仍是编辑前的旧文本——用户改正了摘要，问答却还在引用错误内容。
 */
export async function reindexSummaryChunks(
  meetingId: string,
  projectId: string | null,
  summary: Summary,
  apiKey: string,
  totalLines: number | null,
): Promise<void> {
  // 会议日期可能被一起改了。transcript chunks 的正文没变不用重新 embed，
  // 但 meeting_date 必须同步，否则按日期过滤的检索会漏掉这次会议的逐字稿。
  const meetingDate = summary.meta?.date ?? null;
  await prisma.chunk.updateMany({
    where: { meeting_id: meetingId, chunk_type: "transcript" },
    data: { meeting_date: meetingDate },
  });
  await prisma.chunkParent.updateMany({
    where: { meeting_id: meetingId },
    data: { meeting_date: meetingDate },
  });

  await prisma.chunk.deleteMany({
    where: { meeting_id: meetingId, chunk_type: "summary" },
  });
  const { chunks: inputs, droppedLines } = buildSummaryChunks(
    summary, meetingId, projectId ?? undefined, totalLines,
  );
  if (droppedLines > 0) {
    await prisma.processingLog.create({
      data: {
        level: "warn",
        meeting_id: meetingId,
        context: encryptJSON({ type: "source_lines_out_of_range", dropped: droppedLines, total_lines: totalLines }),
      },
    }).catch(() => {});
  }
  if (inputs.length === 0) return;
  const created = await insertChunks(inputs);
  await embedAndStore(created, meetingId, apiKey);
}

/**
 * 给 chunks 算向量并写回。
 *
 * meetingId 只用于 ProcessingLog 的归属，参考文件传 null（它不属于任何会议）。
 * 返回累计 embedding token：后台任务要把它记进 Job.tokens_used，否则"昨晚花了
 * 多少钱"这个问题只能靠猜。
 */
export async function embedAndStore(
  chunks: Array<ChunkInput & { id: string }>,
  meetingId: string | null,
  apiKey: string,
): Promise<{ tokens: number }> {
  const BATCH = 10;
  let tokens = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    let vectors: number[][];
    try {
      const res = await fetchEmbeddings(batch.map((c) => c.content), apiKey);
      vectors = res.embeddings;
      tokens += res.usage?.total_tokens ?? 0;
    } catch (e) {
      await prisma.processingLog.create({
        data: { level: "error", meeting_id: meetingId, context: encryptJSON({ type: "embedding_batch_failed", batch_start: i, detail: String(e) }) },
      });
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = `[${vectors[j].join(",")}]`;
      try {
        await prisma.$executeRaw`UPDATE "Chunk" SET embedding = ${vec}::vector WHERE id = ${batch[j].id}`;
      } catch (e) {
        await prisma.processingLog.create({
          data: { level: "error", meeting_id: meetingId, context: encryptJSON({ type: "embedding_write_failed", chunk_id: batch[j].id, detail: String(e) }) },
        });
      }
    }
  }
  return { tokens };
}

export async function buildAndStoreParents(
  transcriptChunks: Array<ChunkInput & { id: string }>,
): Promise<void> {
  for (let i = 0; i < transcriptChunks.length; i += PARENT_WINDOW) {
    const group = transcriptChunks.slice(i, i + PARENT_WINDOW);
    const content = group.map((c) => c.search_text ?? c.content).join("\n");
    const uniqueSpeakers = [...new Set(group.flatMap((c) => (c.speaker ? [c.speaker] : [])))];
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

/** 参考文件切块的目标长度。文档比口语密，可以比逐字稿的 200 长一些。 */
const REFERENCE_CHUNK_CHARS = 500;

/**
 * 参考文件 → chunks。按文档有没有结构分派。
 *
 * 实测（3 份真实文档、101 个问题、top_k=6，与生产同参数）：
 *
 *   | | 按长度切 | 按章节切 |
 *   |---|---|---|
 *   | 标题型问题命中 | 46/47 | **47/47** |
 *   | 原句型问题命中 | 50/54 | **53/54** |
 *   | 取回正文字数   | 3300  | **2260（−30%）** |
 *   | chunk 数 / 建索引 token | 51 / 14438 | 93 / 16991（+18%） |
 *
 * 两组问题分别偏向一方（标题型的问题就是标题本身，偏向章节；原句型要罩住某一行，
 * 块越大越占便宜，偏向长度），按章节切**两组都赢**，而且少取回三成正文——同样
 * 命中的前提下进 LLM 的噪声更少。多出来的 18% token 是每块重复的章节路径。
 *
 * 没有标题的文档（扫描件转写、纯文本流水账）退回按长度切。
 */
export function buildReferenceChunks(
  text: string,
  referenceDocId: string,
  projectId: string | null,
  docName: string,
): ChunkInput[] {
  const st = detectStructure(text);
  // 两个标题起步：一个孤零零的标题（多半就是文档大标题）切不出章节，
  // 反而把整份文档变成一块。
  return st.headings >= 2
    ? buildSectionChunks(text, referenceDocId, projectId, docName)
    : buildLengthChunks(text, referenceDocId, projectId, docName);
}

/**
 * 纯按长度累积切块。没有标题可依时的兜底。
 *
 * 和逐字稿不同，文档没有说话人轮次可依，按行累积到目标长度即切。line_start /
 * line_end 仍然记着——这样参考文件也能溯源到原文的具体位置，而不是只能引"某份
 * 文件"。行号基准与会议一致：过滤空行后从 1 开始（见 utils.numberedLines）。
 */
export function buildLengthChunks(
  text: string,
  referenceDocId: string,
  projectId: string | null,
  docName: string,
): ChunkInput[] {
  const lines = numberedLines(text);
  const chunks: ChunkInput[] = [];
  let buffer: string[] = [];
  let lineStart = 1;

  const flush = (lineEnd: number) => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) { lineStart = lineEnd + 1; return; }
    // 正文里带上文件名：检索命中时能立刻看出这段来自哪份文件，
    // 也让"那份需求文档怎么说的"这类问法有东西可匹配。
    const plainText = `${docName}\n${body}`;
    chunks.push({
      meeting_id: null,
      reference_doc_id: referenceDocId,
      project_id: projectId,
      chunk_type: "reference",
      content: plainText,
      search_text: plainText,
      section_title: docName,
      speaker: null,
      line_start: lineStart,
      line_end: lineEnd,
      // 参考文件没有会议日期。按日期过滤时它不该被排除掉——null 在
      // meeting_date 过滤里本来就不参与匹配，这里保持 null 是有意的。
      meeting_date: null,
    });
    lineStart = lineEnd + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    buffer.push(lines[i]);
    if (buffer.join("").length >= REFERENCE_CHUNK_CHARS) flush(i + 1);
  }
  flush(lines.length);
  return chunks;
}

/**
 * 标题行。Markdown 原生就是 `#`，.docx 经 convertToHtml + htmlToText 之后也是
 * 这个形态（见 lib/documentParser.ts），所以两种格式在这里只需要认一种记号。
 */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * 章节路径的分隔符。不用 `/`：文件名和标题里都可能有斜杠。
 *
 * 导出是因为 ask 路由要靠它从 `section_title` 里把文件名切回来
 * （模型在引用里报的是 `文件名 › 章节`，而来源解析需要的是文件名）。
 */
export const REFERENCE_TITLE_SEP = " › ";
const PATH_SEP = REFERENCE_TITLE_SEP;

export type DocStructure = {
  headings: number;
  /** 落在某个标题之下的行占比。标题只有一个孤零零挂在开头时这个值会很低。 */
  covered: number;
  /** 最大的一节有多少行。一个标题底下压着整份文档时，按章节切等于没切。 */
  maxSectionLines: number;
};

/** 探测文档的结构。只看标题记号，不调模型。 */
export function detectStructure(text: string): DocStructure {
  const lines = numberedLines(text);
  let headings = 0;
  let covered = 0;
  let cur = 0;
  let maxSectionLines = 0;
  let seenHeading = false;
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      headings++;
      seenHeading = true;
      maxSectionLines = Math.max(maxSectionLines, cur);
      cur = 0;
    } else if (seenHeading) {
      covered++;
      cur++;
    }
  }
  maxSectionLines = Math.max(maxSectionLines, cur);
  const body = lines.length - headings;
  return { headings, covered: body > 0 ? covered / body : 0, maxSectionLines };
}

/**
 * 参考文件 → chunks，**按章节切**。
 *
 * 和 buildReferenceChunks（纯按长度累积）的区别只有一条：**标题是硬边界**。
 * 一节结束就切，不跟下一节的内容混在一块里。
 *
 * 章节内仍然按长度再切一刀 —— 这不是可选的：一个十页的章节就是一块，而 chunk
 * 大小本来就没有上界（实测单行 4000 字 → 1 块 4007 字）。超长 chunk 会顶穿
 * embedding 的输入上限，而 embedAndStore 对批次失败是记日志后 continue，
 * 结果是这条 chunk 留在库里但没有向量，向量检索永远取不到它。
 *
 * 每一块都带上**完整章节路径**（`1. 性能指标 › 1.1 吞吐量`），而不只是最近的
 * 那级标题：同一份文档里 "1.1 指标" 和 "2.1 指标" 可以同名，只给最近一级的话
 * 检索命中后根本分不清是哪一节。同一节切出的第 2、3 块也各自重复一遍路径，
 * 否则后半节脱离标题之后就是一段无主的文字。
 */
export function buildSectionChunks(
  text: string,
  referenceDocId: string,
  projectId: string | null,
  docName: string,
): ChunkInput[] {
  const lines = numberedLines(text);
  const chunks: ChunkInput[] = [];
  /** 标题栈：下标 = 层级 - 1 */
  let stack: string[] = [];
  let buffer: string[] = [];
  let lineStart = 1;

  const flush = (lineEnd: number) => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) { lineStart = lineEnd + 1; return; }
    // 路径一律从 stack 现算，不另存一份——两个来源迟早会不同步。
    // flush 总是在更新 stack **之前**调用，所以这里拿到的是刚结束那一节的路径。
    const path = stack.filter(Boolean);
    // 正文里放**完整路径**：同名小节（"1.1 指标" vs "2.1 指标"）靠上级标题才分得开，
    // 实测这是按章节切赢下来的一部分。
    const fullPath = path.length ? `${docName}${PATH_SEP}${path.join(PATH_SEP)}` : docName;
    // 但 section_title 只放**最后一级**：它要作为行内引用显示
    // （`[参考文件 · PRD-v2.md › 1.1 核心洞察]`），完整路径挂在句尾没法看。
    const leaf = path.at(-1);
    const title = leaf ? `${docName}${PATH_SEP}${leaf}` : docName;
    const plainText = `${fullPath}\n${body}`;
    chunks.push({
      meeting_id: null,
      reference_doc_id: referenceDocId,
      project_id: projectId,
      chunk_type: "reference",
      content: plainText,
      search_text: plainText,
      section_title: title,
      speaker: null,
      line_start: lineStart,
      line_end: lineEnd,
      meeting_date: null,
    });
    lineStart = lineEnd + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = HEADING_RE.exec(line);
    if (m) {
      // 标题是硬边界：先把上一节收尾，再更新路径
      flush(i);
      const level = m[1].length;
      stack = stack.slice(0, level - 1);
      stack[level - 1] = m[2].trim();
      lineStart = i + 1;
      // 标题行本身留在正文里：用户会直接搜标题里的词
      buffer.push(line);
      continue;
    }
    buffer.push(line);
    if (buffer.join("").length >= REFERENCE_CHUNK_CHARS) flush(i + 1);
  }
  flush(lines.length);
  return chunks;
}
