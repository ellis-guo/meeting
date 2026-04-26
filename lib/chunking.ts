import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";

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

export async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-v3", input: texts, dimension: 1024 }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} — ${await res.text()}`);
  return ((await res.json()).data as Array<{ embedding: number[] }>).map((d) => d.embedding);
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
      vectors = await fetchEmbeddings(batch.map((c) => c.content), apiKey);
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
