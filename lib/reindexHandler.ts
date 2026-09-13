import { prisma } from "@/lib/prisma";
import { decrypt, decryptJSON, encryptJSON } from "@/lib/crypto";
import { numberedLineCount } from "@/lib/utils";
import {
  buildAndStoreParents, buildSummaryChunks, embedAndStore, insertChunks,
  type ChunkInput, type Summary,
} from "@/lib/chunking";
import type { ClaimedJob } from "@/lib/jobs";

// reindex 的处理函数：把一场会议的向量索引补齐或重建。
//
// 在此之前这两件事都是裸 `fn().catch(() => {})`：
//   - 新会议建完 chunk 后的 embedAndStore / buildAndStoreParents
//   - 用户改完摘要后的 reindexSummaryChunks
// 进程一重启就静默消失，chunk 留在库里永远没有向量——而向量检索的 SQL 一律带
// `embedding IS NOT NULL`，所以它不是"慢一点"，是**这场会议从此检索不到**，
// 而且界面上完全看不出来。Job 表当初就是为这个建的（见 lib/jobs.ts 的开头）。

export type ReindexPayload = {
  meetingId: string;
  /** initial = 新会议补齐向量和父块；summary = 摘要被编辑后重建 summary chunk。 */
  mode: "initial" | "summary";
};

function isPayload(v: unknown): v is ReindexPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as ReindexPayload;
  return typeof o.meetingId === "string" && (o.mode === "initial" || o.mode === "summary");
}

async function log(meetingId: string, level: string, context: Record<string, unknown>): Promise<void> {
  await prisma.processingLog
    .create({ data: { level, meeting_id: meetingId, context: encryptJSON(context) } })
    .catch(() => {});
}

/**
 * 把这场会议所有还没有向量的 chunk 补上。
 *
 * 按"缺什么补什么"而不是"这次新建了哪些"：这样它天然幂等，重试不会重复付费；
 * 更要紧的是它**能自愈历史欠账**——之前 fire-and-forget 丢掉的那些 chunk，
 * 只要再排一次任务就能补回来，不需要专门写个修数据脚本。
 */
async function embedMissing(meetingId: string, apiKey: string): Promise<{ embedded: number; tokens: number }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; content: string }>>`
    SELECT id, content FROM "Chunk"
    WHERE meeting_id = ${meetingId} AND embedding IS NULL
    ORDER BY line_start NULLS LAST, id
  `;
  if (rows.length === 0) return { embedded: 0, tokens: 0 };
  // embedAndStore 只读 id 和 content，其余字段填占位即可
  const items = rows.map((r) => ({
    id: r.id, content: r.content,
    meeting_id: meetingId, reference_doc_id: null, project_id: null,
    chunk_type: "", search_text: null, section_title: null, speaker: null,
    line_start: null, line_end: null, meeting_date: null,
  }));
  const { tokens } = await embedAndStore(items, meetingId, apiKey);
  return { embedded: rows.length, tokens };
}

/**
 * 父块：逐字稿每 PARENT_WINDOW 条归一块，检索命中子块时用它扩上下文。
 *
 * 已经有父块就跳过。不这么判的话重试会把父块建两遍，而 ChunkParent 没有唯一约束
 * ——重复的父块会让同一段对话在上下文里出现多次，白占 token 还稀释别的来源。
 */
async function buildParentsIfMissing(meetingId: string): Promise<number> {
  const existing = await prisma.chunkParent.count({ where: { meeting_id: meetingId } });
  if (existing > 0) return 0;

  const rows = await prisma.chunk.findMany({
    where: { meeting_id: meetingId, chunk_type: "transcript" },
    // 父块是"连续几条合成一段对话"，顺序错了就串台。line_start 是逐字稿里的
    // 真实顺序，不能用 created_at（同一批 createMany 的时间戳分不出先后）。
    orderBy: [{ line_start: "asc" }, { id: "asc" }],
    select: {
      id: true, meeting_id: true, project_id: true, meeting_date: true,
      content: true, search_text: true, speaker: true, line_start: true, line_end: true,
    },
  });
  if (rows.length === 0) return 0;

  await buildAndStoreParents(
    rows.map((r) => ({
      ...r,
      reference_doc_id: null,
      chunk_type: "transcript",
    })) as Array<ChunkInput & { id: string }>,
  );
  return await prisma.chunkParent.count({ where: { meeting_id: meetingId } });
}

/** 摘要被编辑后重建 summary chunk。transcript chunk 不受影响，保持原样。 */
async function rebuildSummaryChunks(
  meetingId: string,
  projectId: string | null,
  summary: Summary,
  transcript: string | null,
  apiKey: string,
): Promise<{ chunks: number; tokens: number; dropped: number }> {
  const meetingDate = summary.meta?.date ?? null;
  // 会议日期可能被一起改了。transcript chunk 的正文没变不用重新 embed，
  // 但 meeting_date 必须同步，否则按日期过滤的检索会漏掉这次会议的逐字稿。
  await prisma.chunk.updateMany({
    where: { meeting_id: meetingId, chunk_type: "transcript" },
    data: { meeting_date: meetingDate },
  });
  await prisma.chunkParent.updateMany({
    where: { meeting_id: meetingId },
    data: { meeting_date: meetingDate },
  });

  await prisma.chunk.deleteMany({ where: { meeting_id: meetingId, chunk_type: "summary" } });

  // source_lines 的校验基准。解不开逐字稿就传 null：跳过越界校验，总比把用户
  // 这次编辑之外、本来正确的锚点全清掉好。
  let totalLines: number | null = null;
  if (transcript !== null) {
    try { totalLines = numberedLineCount(transcript); } catch { /* 保持 null */ }
  }

  const { chunks: inputs, dropped } = (() => {
    const r = buildSummaryChunks(summary, meetingId, projectId ?? undefined, totalLines);
    return { chunks: r.chunks, dropped: r.droppedLines };
  })();
  if (inputs.length === 0) return { chunks: 0, tokens: 0, dropped };

  const created = await insertChunks(inputs);
  const { tokens } = await embedAndStore(created, meetingId, apiKey);
  return { chunks: created.length, tokens, dropped };
}

export async function runReindexMeeting(job: ClaimedJob): Promise<{ tokensUsed?: number } | void> {
  if (!isPayload(job.payload)) throw new Error("reindex 的 payload 形状不对");
  const { meetingId, mode } = job.payload;

  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, project_id: true, summary: true, transcript: true },
  });
  // 会议在排队期间被删了。该做的事已经不存在了，不是失败。
  if (!meeting) return;

  // 不能用 getDashScopeKey()：它读 cookie + Clerk auth，都是请求作用域的。
  const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY 未配置，无法重建检索索引");

  if (mode === "summary") {
    let summary: Summary;
    try {
      summary = decryptJSON<Summary>(meeting.summary);
    } catch {
      // 摘要解不开，重试也解不开。记一条就走，别烧重试次数。
      await log(meetingId, "error", { type: "summary_reindex_unreadable" });
      return;
    }
    let transcript: string | null = null;
    try { transcript = decrypt(meeting.transcript); } catch { /* 保持 null */ }

    const r = await rebuildSummaryChunks(meetingId, meeting.project_id, summary, transcript, apiKey);
    await log(meetingId, r.dropped > 0 ? "warn" : "info", {
      type: "summary_reindexed", chunks: r.chunks, dropped_lines: r.dropped, tokens: r.tokens,
    });
    return { tokensUsed: r.tokens };
  }

  const { embedded, tokens } = await embedMissing(meetingId, apiKey);
  const parents = await buildParentsIfMissing(meetingId);
  await log(meetingId, "info", { type: "meeting_indexed", embedded, parents, tokens });
  return { tokensUsed: tokens };
}
