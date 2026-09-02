import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";
import { fetchEmbeddings } from "@/lib/dashscope";

export const PARENT_WINDOW = 5;

export type SectionContent =
  | { type: "text"; value: string; source_lines: number[] }
  | { type: "bullets"; items: Array<{ text: string; source_lines: number[]; sub_items?: Array<{ text: string; source_lines: number[] }> }> }
  | { type: "table"; columns: string[]; rows: Array<{ cells: string[]; source_lines: number[] }> };

export type Section = { title: string; content: SectionContent };

export type Summary = {
  meta: { date: string | null; time: string | null; participants: string[] };
  sections: Section[];
  humanistic_note: string | null;
};

export type ChunkInput = {
  meeting_id: string;
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

export function buildSummaryChunks(summary: Summary, meetingId: string, projectId?: string): ChunkInput[] {
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
  const lines = transcript.split("\n").filter((l) => l.trim());
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
      meeting_id: meetingId, project_id: projectId ?? null, chunk_type: "transcript",
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
  const inputs = buildSummaryChunks(summary, meetingId, projectId ?? undefined);
  if (inputs.length === 0) return;
  const created = await insertChunks(inputs);
  await embedAndStore(created, meetingId, apiKey);
}

export async function embedAndStore(
  chunks: Array<ChunkInput & { id: string }>,
  meetingId: string,
  apiKey: string,
): Promise<void> {
  const BATCH = 10;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    let vectors: number[][];
    try {
      vectors = (await fetchEmbeddings(batch.map((c) => c.content), apiKey)).embeddings;
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
