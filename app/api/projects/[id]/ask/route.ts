import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { extractKeywords } from "@/lib/jieba";
import { callDashScope, callDashScopeStream, fetchEmbedding, fetchEmbeddings, FAST_CHAT_MODEL, DashScopeUsage } from "@/lib/dashscope";
import { ASK_DEBUG, extractJSON } from "@/lib/utils";
import { ASK_SYSTEM_PROMPT, ANALYZE_SYSTEM_PROMPT } from "@/lib/prompts";
import { Prisma } from "@/app/generated/prisma/client";
import { checkRateLimit } from "@/lib/ratelimit";
import { SOURCES_SEP, SSE_HEADERS, sseFrame as send } from "@/lib/sse";
import { renderIndexDigest, type ProjectIndex } from "@/lib/projectIndex";
import { REFERENCE_TITLE_SEP } from "@/lib/chunking";

type QueryAnalysis = {
  queries: string[];
  intent: "project" | "speaker" | "date" | "meeting" | "audit" | "general";
  speakers: string[];
  date_filter: string | null;
  /**
   * 日期在问题里扮演什么角色。eq=某一天 / gte=之后 / lte=之前 / none=只是问题内容不作筛选。
   *
   * none 是关键：「Ellis 感冒发生在 3.20 之前吗」这类问题，正确答案恰恰落在该日期之外
   * （实际是 4.3）。若按 meeting_date = '2026-03-20' 过滤，答案结构性地检索不到，
   * 系统只能答"不知道"或者编——而且这个错误是间歇性的，很难归因。
   */
  date_op: "eq" | "gte" | "lte" | "none";
  meeting_count: number;
};

const ANALYZE_FALLBACK: QueryAnalysis = {
  queries: [],
  intent: "general",
  speakers: [],
  date_filter: null,
  date_op: "eq",
  meeting_count: 1,
};

async function analyzeQuery(
  question: string,
  apiKey: string,
  today: string,
  /**
   * 项目索引摘要，见 lib/projectIndex.renderIndexDigest。空串 = 该项目还没建过
   * 索引（dreaming 没跑过或语料为空），此时行为与接入之前完全一致。
   */
  indexDigest: string,
): Promise<{ result: QueryAnalysis; usage: DashScopeUsage | null }> {
  try {
    // 索引在前、问题在后：问题是要动手处理的东西，放末尾模型的注意力最稳
    const context = indexDigest
      ? `<project_index>\n${indexDigest}\n</project_index>\n\n当前日期：${today}\n问题：${question}`
      : `当前日期：${today}\n问题：${question}`;
    const { content: raw, usage } = await callDashScope(
      ANALYZE_SYSTEM_PROMPT,
      context,
      apiKey,
      FAST_CHAT_MODEL,
    );
    const parsed = extractJSON(raw) as Record<string, unknown>;
    const intent =
      (
        ["project", "speaker", "date", "meeting", "audit", "general"] as const
      ).find((i) => i === parsed.intent) ?? "general";
    const queries = Array.isArray(parsed.queries)
      ? (parsed.queries as unknown[])
          .filter((q): q is string => typeof q === "string")
          .slice(0, 2)
      : [];
    const speakers = Array.isArray(parsed.speakers)
      ? (parsed.speakers as unknown[])
          .filter(
            (s): s is string => typeof s === "string" && s.trim().length > 0,
          )
          .slice(0, 2)
      : [];
    const date_filter =
      typeof parsed.date_filter === "string" ? parsed.date_filter : null;
    // 模型给了未知值就退回 eq（保持原有行为），不要静默变成 none 把过滤整个关掉
    const date_op = (["eq", "gte", "lte", "none"] as const).find(
      (o) => o === parsed.date_op,
    ) ?? "eq";
    const meeting_count =
      typeof parsed.meeting_count === "number" && parsed.meeting_count >= 1
        ? Math.min(Math.round(parsed.meeting_count), 5)
        : 1;
    return { result: { queries, intent, speakers, date_filter, date_op, meeting_count }, usage };
  } catch {
    return { result: ANALYZE_FALLBACK, usage: null };
  }
}

type ChunkRow = {
  id: string;
  meeting_id: string;
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  meeting_date: string | null;
  search_text: string | null;
  parent_id: string | null;
  cosine_dist?: number;
  // 只有参考文件那一路 SELECT 了。会议那边的溯源锚点走的是 meeting_id + 日期，
  // 不需要行号；参考文件没有日期，行号是它唯一能落到原文哪一段的依据。
  line_start?: number | null;
  line_end?: number | null;
};

type ParentRow = {
  id: string;
  meeting_id: string;
  meeting_date: string | null;
  content: string;
  speakers: string;
};

function rrfMerge(
  lists: ChunkRow[][],
  k = 60,
): { chunks: ChunkRow[]; scores: Map<string, number> } {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((chunk, rank) => {
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  const seen = new Set<string>();
  const chunks = lists
    .flat()
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  return { chunks, scores };
}

function cliffCutoff(
  chunks: ChunkRow[],
  scores: Map<string, number>,
  cap: number,
  extraAfterCliff = 0,
  minKeep = 3,
): ChunkRow[] {
  const capped = chunks.slice(0, cap);
  if (capped.length <= minKeep) return capped;
  let maxDrop = 0;
  let cliffIdx = capped.length - 1;
  for (let i = 0; i < capped.length - 1; i++) {
    const drop =
      (scores.get(capped[i].id) ?? 0) - (scores.get(capped[i + 1].id) ?? 0);
    if (drop > maxDrop) {
      maxDrop = drop;
      cliffIdx = i;
    }
  }
  const cutoff = Math.min(
    capped.length,
    Math.max(minKeep, cliffIdx + 1 + extraAfterCliff),
  );
  return capped.slice(0, cutoff);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkRateLimit(userId, "POST:/api/projects/ask");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试（每分钟最多 20 次）" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const apiKey =
    (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "API key required. Please configure your DashScope API key in Settings.",
      },
      { status: 401 },
    );
  }

  const { id: projectId } = await params;
  const { question } = await req.json();

  if (!question?.trim() || question.length > 2000) {
    return NextResponse.json(
      { error: !question?.trim() ? "question is required" : "question too long (max 2000 characters)" },
      { status: 400 },
    );
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, user_id: userId },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // 原来这里有一道门：只要有会议的 diff_status='pending'，项目提问一律 409，
  // 要求用户先去确认主文档更新。主文档下线后这道门连同 diff 流程一起没了
  // ——"不被溯源 ⇔ 不需要确认"是同一个决策的两面（PRD 5.2）。

  const tTotal = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // 项目索引层：只进查询分析，不进生成上下文——所以它永远不会被当成引用来源。
  // 解不开或还没建过就退化成空串，问答行为与接入之前一致。
  let indexDigest = "";
  if (project.index_json) {
    try {
      indexDigest = renderIndexDigest(decryptJSON<ProjectIndex>(project.index_json));
    } catch {
      indexDigest = "";
    }
  }

  // Phase 1: analyze query (rewrite + intent + entities) + embed original — parallel
  let queryVec: number[];
  let analysis: QueryAnalysis;
  let analyzeMs = 0,
    embedOriginalMs = 0;
  let analyzeUsage: DashScopeUsage | null = null;
  let embedOriginalUsage: DashScopeUsage | null = null;
  try {
    [[analysis, analyzeMs], [queryVec, embedOriginalMs]] = await Promise.all([
      (async () => {
        const t = Date.now();
        const { result, usage } = await analyzeQuery(question, apiKey, today, indexDigest);
        analyzeUsage = usage;
        return [result, Date.now() - t] as [QueryAnalysis, number];
      })(),
      (async () => {
        const t = Date.now();
        const { embedding: r, usage } = await fetchEmbedding(question, apiKey);
        embedOriginalUsage = usage;
        return [r, Date.now() - t] as [number[], number];
      })(),
    ]);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  // 日期角色。date_op=none 表示日期只是问题内容而非筛选范围，此时一律不加日期条件。
  const explicitDate =
    analysis.date_filter && /^\d{4}-\d{2}-\d{2}$/.test(analysis.date_filter)
      ? analysis.date_filter
      : null;
  const dateActive = explicitDate !== null && analysis.date_op !== "none";
  // meeting_date 是 YYYY-MM-DD 字符串列，字典序比较等价于日期比较
  const dateWhereExplicit =
    analysis.date_op === "gte"
      ? Prisma.sql`meeting_date >= ${explicitDate}`
      : analysis.date_op === "lte"
        ? Prisma.sql`meeting_date <= ${explicitDate}`
        : Prisma.sql`meeting_date = ${explicitDate}`;

  // Phase 2: embed rewrite variants + resolve date + date meeting count — parallel
  const tPhase2 = Date.now();
  let embedVariantsUsage: DashScopeUsage | null = null;
  const [variantVecs, resolvedDate, resolvedDates, dateMeetingCount] =
    await Promise.all([
      analysis.queries.length > 0
        ? fetchEmbeddings(analysis.queries, apiKey)
            .then(({ embeddings, usage }) => { embedVariantsUsage = usage; return embeddings; })
            .catch(() => [] as number[][])
        : Promise.resolve([] as number[][]),
      // Single resolved date: latest one meeting, or explicit YYYY-MM-DD
      analysis.date_filter === "latest" && analysis.meeting_count <= 1
        ? prisma.$queryRaw<[{ d: string | null }]>`
          SELECT MAX(meeting_date) as d FROM "Chunk" WHERE project_id = ${projectId}
        `.then((r) => r[0]?.d ?? null)
        : Promise.resolve(dateActive ? explicitDate : null),
      // Multi-date: top-N distinct meeting_dates for "最近N次"
      analysis.date_filter === "latest" && analysis.meeting_count > 1
        ? prisma.$queryRaw<Array<{ d: string }>>`
          SELECT DISTINCT meeting_date as d FROM "Chunk"
          WHERE project_id = ${projectId} AND meeting_date IS NOT NULL
          ORDER BY meeting_date DESC
          LIMIT ${analysis.meeting_count}
        `.then((r) => (r.length > 0 ? r.map((row) => row.d) : null))
        : Promise.resolve(null as string[] | null),
      analysis.intent === "date" && dateActive
        ? prisma.$queryRaw<[{ cnt: bigint }]>`
          SELECT COUNT(DISTINCT meeting_id)::int AS cnt FROM "Chunk"
          WHERE project_id = ${projectId} AND ${dateWhereExplicit}
        `.then((r) => Number(r[0]?.cnt ?? 1))
        : Promise.resolve(1),
    ]);
  const embedVariantsMs = Date.now() - tPhase2;

  // resolvedDate 可能来自 "latest" 的 DB 查询（那种情况就是某一天，按 eq）
  const dateWhereResolved =
    dateActive && analysis.date_op === "gte"
      ? Prisma.sql`meeting_date >= ${resolvedDate}`
      : dateActive && analysis.date_op === "lte"
        ? Prisma.sql`meeting_date <= ${resolvedDate}`
        : Prisma.sql`meeting_date = ${resolvedDate}`;

  const allVecs = [queryVec, ...variantVecs];
  const allVecStrs = allVecs.map((v) => `[${v.join(",")}]`);

  // Phase 3: intent-based retrieval
  const tRetrieval = Date.now();

  // Determine effective intent with fallback rules
  const validSpeakers = analysis.speakers
    .filter((s) => s.trim().length > 0)
    .slice(0, 2);
  const effectiveIntent =
    analysis.intent === "speaker" && validSpeakers.length === 0
      ? "general"
      : analysis.intent === "date" && !resolvedDate
        ? "general"
        : (analysis.intent as
            | "project"
            | "speaker"
            | "date"
            | "meeting"
            | "audit"
            | "general");

  // Dynamic candidate cap per intent
  const BASE = 8;
  const candidateCap =
    effectiveIntent === "project"
      ? BASE
      : effectiveIntent === "speaker"
        ? Math.min(BASE * Math.max(validSpeakers.length, 1), 24)
        : effectiveIntent === "date"
          ? Math.min(BASE * Math.max(dateMeetingCount, 1), 24)
          : effectiveIntent === "meeting"
            ? Math.min(BASE * Math.max(analysis.meeting_count, 1), 24)
            : effectiveIntent === "audit"
              ? 16
              : 12; // general

  // Dynamic SQL LIMIT per vector (scales with candidateCap, must be after candidateCap)
  const summaryLimitPerVec = Math.max(4, Math.ceil(candidateCap / 2));
  const transcriptLimitPerVec = Math.max(8, candidateCap);
  const referenceLimitPerVec = Math.max(4, Math.ceil(candidateCap / 2));

  let summaryResultsPerVec: ChunkRow[][] = [];
  let transcriptResultsPerVec: ChunkRow[][] = [];
  let bm25Hits: ChunkRow[] = [];
  let ilikeHits: ChunkRow[] = [];

  /**
   * 参考文件不跟着 intent 分支走。
   *
   * 下面每个分支的差别都在**日期和说话人的过滤方式**上——而参考文件两样都没有
   * （`meeting_date` 和 `speaker` 恒为 null，见 buildReferenceChunks 的注释）。
   * 所以它只有一个问题要回答：这次该不该检索它。
   *
   * `date` / `meeting` 两类问题是**钉在某次会议上**的（"4月9日那次说了什么"、
   * "上次会议的结论"），参考文件没有日期，掺进去只能是噪声——而且更糟的是，
   * 它会挤掉本来就按日期筛得很窄的候选。其余意图（project / speaker / audit /
   * general）都该看参考文件：需求文档恰恰是"项目目标是什么""有没有遗漏"这类
   * 问题的第一手依据。
   */
  const wantReference =
    effectiveIntent !== "date" && effectiveIntent !== "meeting";

  // 提前发出去，和下面分支里的查询并发跑——promise 是即时启动的，放在 if/else
  // 之前不会串行化，也省得在六个分支里各加一遍。
  const referencePromise: Promise<ChunkRow[][]> = wantReference
    ? Promise.all(
        allVecStrs.map(
          (vecStr) =>
            prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 line_start, line_end,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'reference'
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${referenceLimitPerVec}
        `,
        ),
      )
    : Promise.resolve([]);

  if (effectiveIntent === "project") {
    // 宏观问题：只看会议摘要（主文档已下线，参考文件由 referencePromise 那一路带上）
    summaryResultsPerVec = await Promise.all(
      allVecStrs.map(
        (vecStr) =>
          prisma.$queryRaw<ChunkRow[]>`
        SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
               embedding <=> ${vecStr}::vector AS cosine_dist
        FROM "Chunk"
        WHERE project_id = ${projectId}
          AND chunk_type = 'summary'
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT ${summaryLimitPerVec}
      `,
      ),
    );
  } else if (effectiveIntent === "speaker") {
    // All summary chunks + transcript chunks filtered by speaker (cross-meeting coverage)
    const speakerPattern = validSpeakers.map(escapeRegex).join("|");
    [summaryResultsPerVec, transcriptResultsPerVec] = await Promise.all([
      Promise.all(
        allVecStrs.map(
          (vecStr) =>
            prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${summaryLimitPerVec}
        `,
        ),
      ),
      Promise.all(
        allVecStrs.map(
          (vecStr) =>
            prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND embedding IS NOT NULL
            AND speaker ~* ${speakerPattern}
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${transcriptLimitPerVec}
        `,
        ),
      ),
    ]);
  } else if (
    effectiveIntent === "date" ||
    (effectiveIntent === "meeting" && resolvedDate)
  ) {
    // Summary + transcript filtered by single resolved date
    [summaryResultsPerVec, transcriptResultsPerVec] = await Promise.all([
      Promise.all(
        allVecStrs.map(
          (vecStr) =>
            prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND ${dateWhereResolved}
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${summaryLimitPerVec}
        `,
        ),
      ),
      Promise.all(
        allVecStrs.map(
          (vecStr) =>
            prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND ${dateWhereResolved}
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${transcriptLimitPerVec}
        `,
        ),
      ),
    ]);
  } else if (effectiveIntent === "meeting" && resolvedDates) {
    // "最近N次会议"：多日期过滤，dates 来自 DB 查询，值可信
    const joinedDates = Prisma.join(resolvedDates);
    [summaryResultsPerVec, transcriptResultsPerVec] = await Promise.all([
      Promise.all(
        allVecStrs.map((vecStr) =>
          prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND meeting_date IN (${joinedDates})
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${summaryLimitPerVec}
        `,
        ),
      ),
      Promise.all(
        allVecStrs.map((vecStr) =>
          prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND meeting_date IN (${joinedDates})
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${transcriptLimitPerVec}
        `,
        ),
      ),
    ]);
  } else if (effectiveIntent === "meeting") {
    // Summary + transcript, no date filter, no BM25/regex
    [summaryResultsPerVec, transcriptResultsPerVec] = await Promise.all([
      Promise.all(
        allVecStrs.map(
          (vecStr) =>
            prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${summaryLimitPerVec}
        `,
        ),
      ),
      Promise.all(
        allVecStrs.map(
          (vecStr) =>
            prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${transcriptLimitPerVec}
        `,
        ),
      ),
    ]);
  } else {
    // general: full 4-way retrieval
    const keywords = extractKeywords(question);
    const keywordPattern =
      keywords.length > 0 ? keywords.map(escapeRegex).join("|") : null;

    [summaryResultsPerVec, transcriptResultsPerVec, bm25Hits, ilikeHits] =
      await Promise.all([
        Promise.all(
          allVecStrs.map(
            (vecStr) =>
              prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${summaryLimitPerVec}
        `,
          ),
        ),
        Promise.all(
          allVecStrs.map(
            (vecStr) =>
              prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id,
                 embedding <=> ${vecStr}::vector AS cosine_dist
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT ${transcriptLimitPerVec}
        `,
          ),
        ),
        // 这两条关键词检索不带 chunk_type 过滤，三类 chunk 都捞——这是有意的：
        // BM25 和 ilike 走的是字面匹配，参考文件里的术语、字段名、编号恰恰是
        // 向量检索最容易漏而字面最容易中的东西。
        // ⚠️ 但也正因为它们什么都捞，**新增 chunk_type 时必须连这里一起想**：
        // 上面所有向量检索都写死了类型，只有这两条是敞口。类型进了这里却没有
        // 对应的上下文渲染，就会被当成会议片段喂给模型（见下面 referenceChunks
        // 的分流）。
        prisma.$queryRaw<ChunkRow[]>`
        SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id, line_start, line_end
        FROM "Chunk"
        WHERE project_id = ${projectId}
          AND search_text IS NOT NULL
          AND to_tsvector('simple', coalesce(search_text, ''))
              @@ websearch_to_tsquery('simple', ${question})
        ORDER BY ts_rank(
          to_tsvector('simple', coalesce(search_text, '')),
          websearch_to_tsquery('simple', ${question})
        ) DESC
        LIMIT 5
      `,
        keywordPattern
          ? prisma.$queryRaw<ChunkRow[]>`
            SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id, line_start, line_end
            FROM "Chunk"
            WHERE project_id = ${projectId}
              AND search_text IS NOT NULL
              AND search_text ~* ${keywordPattern}
            LIMIT 5
          `
          : Promise.resolve([] as ChunkRow[]),
      ]);
  }

  const referenceResultsPerVec = await referencePromise;

  const retrievalMs = Date.now() - tRetrieval;

  const vecDistMap = new Map<string, (number | null)[]>();
  const numVecs = allVecs.length;
  for (const lists of [summaryResultsPerVec, transcriptResultsPerVec, referenceResultsPerVec]) {
    for (let vi = 0; vi < lists.length; vi++) {
      for (const chunk of lists[vi]) {
        if (!vecDistMap.has(chunk.id)) {
          vecDistMap.set(chunk.id, new Array(numVecs).fill(null));
        }
        vecDistMap.get(chunk.id)![vi] = chunk.cosine_dist ?? null;
      }
    }
  }

  const { chunks: rrfChunks, scores: rrfScores } = rrfMerge([
    ...summaryResultsPerVec,
    ...transcriptResultsPerVec,
    ...referenceResultsPerVec,
    bm25Hits,
    ilikeHits,
  ]);
  const merged = cliffCutoff(rrfChunks, rrfScores, candidateCap);

  // Parent-child: group transcript chunks by parent_id, fetch parents sorted by hit count
  const parentHits = new Map<string, number>();
  const summaryChunks: ChunkRow[] = [];
  const noParentTranscript: ChunkRow[] = [];
  const referenceChunks: ChunkRow[] = [];

  for (const chunk of merged) {
    if (chunk.chunk_type === "summary") {
      summaryChunks.push(chunk);
    } else if (chunk.chunk_type === "reference") {
      // 必须排在 parent_id 判断之前。参考文件的 parent_id 是 null，落到最后那个
      // else 就会被当成"没有父块的逐字稿片段"，渲染成 `[日期未知 · 片段]` 并归进
      // 「会议记录片段」——等于告诉模型这段需求文档是某次会议说的。
      referenceChunks.push(chunk);
    } else if (chunk.parent_id) {
      parentHits.set(
        chunk.parent_id,
        (parentHits.get(chunk.parent_id) ?? 0) + 1,
      );
    } else {
      noParentTranscript.push(chunk);
    }
  }

  const sortedParentIds = [...parentHits.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id);

  let parentRows: ParentRow[] = [];
  if (sortedParentIds.length > 0) {
    const fetched = await prisma.$queryRaw<ParentRow[]>`
      SELECT id, meeting_id, meeting_date, content, speakers FROM "ChunkParent"
      WHERE id IN (${Prisma.join(sortedParentIds)})
    `;
    const parentMap = new Map(fetched.map((p) => [p.id, p]));
    parentRows = sortedParentIds
      .map((id) => parentMap.get(id))
      .filter((p): p is ParentRow => !!p);
  }

  // 主文档不再进生成上下文（PRD 4.5：不呈现、不检索、不引用）。
  //
  // 它原来是"项目目标/成员/背景"这类问题的兜底背景。现在这些只能从会议 chunk
  // 和参考文件里来——而那两样都是**能被引用、能点回原文**的。这正是这个决策想要
  // 的：答案里的每一句都该有出处，而不是来自一份用户看不见、也没法验证的文档。
  //
  // 索引层（index_json）**不是**它的替代品：索引层只进查询分析，结构性地不进
  // 生成上下文，见本文件开头 indexDigest 的注释。
  const contextParts: string[] = [];

  const chunkTexts: string[] = [];
  for (const c of summaryChunks) {
    chunkTexts.push(
      `[${c.meeting_date ?? "日期未知"} · ${c.section_title ?? "摘要"}]\n${c.search_text ?? ""}`,
    );
  }
  for (const p of parentRows) {
    chunkTexts.push(
      `[${p.meeting_date ?? "日期未知"} · 对话片段 (${p.speakers})]\n${p.content}`,
    );
  }
  for (const c of noParentTranscript) {
    chunkTexts.push(
      `[${c.meeting_date ?? "日期未知"} · ${c.speaker ?? "片段"}]\n${c.search_text ?? ""}`,
    );
  }
  if (chunkTexts.length > 0) {
    contextParts.push(`会议记录片段：\n${chunkTexts.join("\n\n---\n\n")}`);
  }

  // 参考文件**单独成块**，绝不能混进上面那堆。
  //
  // 它们不是会议说的话，是项目上传的文档（需求、规范、纪要原件）。混在"会议记录
  // 片段"里，模型会给它安上一个日期去引用——而它压根没有日期，引出来的那次会议
  // 根本没说过这话。标题行也换成 `[参考文件 · 文件名]`，让模型有一个跟会议不同
  // 的引用格式可用（见 ASK_SYSTEM_PROMPT 的规则 6）。
  if (referenceChunks.length > 0) {
    const refTexts = referenceChunks.map(
      (c) => `[参考文件 · ${c.section_title ?? "未命名文件"}]\n${c.search_text ?? ""}`,
    );
    contextParts.push(
      `参考文件片段（项目上传的文档，不是会议记录，没有日期）：\n${refTexts.join("\n\n---\n\n")}`,
    );
  }

  /**
   * 引用标题 → 这次实际取回的行区间。
   *
   * 模型报不出行号——它看到的只是 `[参考文件 · 文件名 › 章节]`。但服务端知道这个
   * 标题对应的是哪几块 chunk，行号就在那上面。取并集：一节太长时会被切成几块，
   * 它们共享同一个 section_title，用户点进去应该看到整节而不是其中一块。
   *
   * 没有这一步，引用只能跳到"这份文档"，跳不到"文档的哪一段"——那和会议引用
   * 能落到具体行就差了一截。
   */
  const refLineIndex = new Map<string, { start: number; end: number }>();
  for (const c of referenceChunks) {
    const key = c.section_title?.trim();
    if (!key || c.line_start == null || c.line_end == null) continue;
    const cur = refLineIndex.get(key);
    refLineIndex.set(key, {
      start: Math.min(cur?.start ?? c.line_start, c.line_start),
      end: Math.max(cur?.end ?? c.line_end, c.line_end),
    });
  }

  const userMessage = `${contextParts.join("\n\n===\n\n")}\n\n问题：${question}`;

  const body = new ReadableStream({
    async start(controller) {
      // 和 LLM 流并发跑。只有这两条是**出结果必需**的：
      // meetingDateIndex 在流结束后把来源里的日期换回 meeting_id；
      // refDocRows 把文件名换回 id——模型在 %%SOURCES%% 里只报得出文件名
      //（它看到的就是 `[参考文件 · 文件名]`），要落成可跳转的来源得在服务端换。
      const essentialPromise = Promise.all([
        prisma.$queryRaw<Array<{ meeting_id: string; meeting_date: string }>>`
          SELECT DISTINCT ON (meeting_date) meeting_id, meeting_date
          FROM "Chunk"
          WHERE project_id = ${projectId} AND meeting_date IS NOT NULL
          ORDER BY meeting_date
        `,
        prisma.referenceDoc.findMany({
          where: { project_id: projectId },
          select: { id: true, name: true },
        }),
      ]);

      // 这三条**只喂 _debug**：两条纯统计 COUNT，加一次 ProcessingLog（拿回来还要
      // 逐条解密）。生产上 _debug 整个字段都不发，所以这一组一条都不查——原先是
      // 无条件跑的，等于每次提问白付 3 条查询 + 5 次解密。
      // ProcessingLog 用子查询而不是先取 meeting id，省一个来回。
      const debugStatsPromise = ASK_DEBUG
        ? Promise.all([
            prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE project_id = ${projectId}`,
            prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE project_id = ${projectId} AND embedding IS NOT NULL`,
            prisma.$queryRaw<Array<{ context: string }>>`
              SELECT context FROM "ProcessingLog"
              WHERE meeting_id IN (SELECT id FROM "Meeting" WHERE project_id = ${projectId})
                AND level = 'error'
              ORDER BY created_at DESC
              LIMIT 5
            `,
          ])
        : null;

      const tAnswer = Date.now();
      let fullText = "";
      let answerUsage: DashScopeUsage | null = null;
      try {
        ({ fullText, usage: answerUsage } = await callDashScopeStream(
          ASK_SYSTEM_PROMPT,
          userMessage,
          apiKey,
          (token) => {
            controller.enqueue(send("token", { text: token }));
          },
          SOURCES_SEP,
        ));
      } catch (e) {
        controller.enqueue(send("error", { error: String(e) }));
        controller.close();
        return;
      }
      const answerMs = Date.now() - tAnswer;

      const [meetingDateRows, refDocRows] = await essentialPromise;
      const meetingDateIndex = new Map(
        meetingDateRows.map((r) => [r.meeting_date, r.meeting_id]),
      );
      const refDocIndex = new Map(refDocRows.map((d) => [d.name, d.id]));

      // Parse sources from separator section
      type RawSource = {
        chunk_type?: string;
        section_title?: string | null;
        speaker?: string | null;
        meeting_date?: string | null;
      };
      const sepIdx = fullText.indexOf(SOURCES_SEP);
      let llmSources: RawSource[] = [];
      if (sepIdx !== -1) {
        try {
          const parsed = JSON.parse(
            fullText.slice(sepIdx + SOURCES_SEP.length).trim(),
          );
          llmSources = Array.isArray(parsed) ? parsed : [];
        } catch {
          /* no valid sources */
        }
      }

      const sources = llmSources.map((s) => {
        if (s.chunk_type === "reference") {
          // section_title 的形态是 `文件名 › 章节标题`（见 buildSectionChunks），
          // 取第一段换回文件名。没有标题的文档就只有文件名，split 后照样是它。
          //
          // 名字对不上就留 null。模型偶尔会把文件名写走样（补个扩展名、改个
          // 标点），而一个指错文件的来源和指对的长得一模一样——宁可不可点击，
          // 也不要跳到另一份文档去（同 pickLines 对越界行号的处理）。
          const title = (s.section_title ?? "").trim();
          const name = title.split(REFERENCE_TITLE_SEP)[0].trim();
          // 行区间只在标题**完全对得上**时才给。对不上说明模型把标题改写了，
          // 这时给一个猜来的区间就会把用户送到文档里错误的位置——比不跳转更糟。
          const range = refLineIndex.get(title) ?? null;
          return {
            meeting_id: null,
            reference_doc_id: refDocIndex.get(name) ?? null,
            chunk_type: "reference",
            section_title: s.section_title ?? null,
            speaker: null,
            line_start: range?.start ?? null,
            line_end: range?.end ?? null,
            // 参考文件没有日期。模型若硬填了一个，这里丢掉——留着会让前端拿它
            // 去匹配会议，匹到哪次算哪次。
            meeting_date: null,
          };
        }
        const meetingId = s.meeting_date
          ? (meetingDateIndex.get(s.meeting_date) ?? null)
          : null;
        return {
          meeting_id: meetingId,
          reference_doc_id: null,
          chunk_type: s.chunk_type ?? "summary",
          section_title: s.section_title ?? null,
          speaker: s.speaker ?? null,
          // 会议的溯源锚点是 meeting_id + 日期，行号由会议页自己从摘要里取
          line_start: null,
          line_end: null,
          meeting_date: s.meeting_date ?? null,
        };
      });

      const citationCounts = { summary: 0, transcript: 0, reference: 0 };
      for (const s of sources) {
        const t = s.chunk_type as keyof typeof citationCounts;
        if (t in citationCounts) citationCounts[t]++;
      }

      const sumUsage = (items: (DashScopeUsage | null)[]) => {
        const valid = items.filter((u): u is DashScopeUsage => u !== null);
        if (valid.length === 0) return null;
        return {
          prompt_tokens: valid.reduce((s, u) => s + u.prompt_tokens, 0),
          completion_tokens: valid.reduce((s, u) => s + (u.completion_tokens ?? 0), 0),
          total_tokens: valid.reduce((s, u) => s + u.total_tokens, 0),
        };
      };

      const donePayload: Record<string, unknown> = { sources };

      // debugStatsPromise 非 null ⇔ ASK_DEBUG 为真。用它本身当条件，比再判一次
      // ASK_DEBUG 好：类型收窄是免费的，不需要非空断言。
      if (debugStatsPromise) {
        const [totalChunksRes, embeddedChunksRes, embeddingLogs] = await debugStatsPromise;
        const recentEmbedErrors = embeddingLogs.map((log) => {
          try {
            return decryptJSON<Record<string, unknown>>(log.context);
          } catch {
            return log.context;
          }
        });

        donePayload._debug = {
          token_usage: {
            analyze: analyzeUsage,
            embed_original: embedOriginalUsage,
            embed_variants: embedVariantsUsage,
            answer: answerUsage,
            total: sumUsage([analyzeUsage, embedOriginalUsage, embedVariantsUsage, answerUsage]),
          },
          source_citation_summary: citationCounts,
          timings_ms: {
            analyze_llm: analyzeMs,
            embed_original: embedOriginalMs,
            embed_variants: embedVariantsMs,
            retrieval: retrievalMs,
            answer_llm: answerMs,
            total: Date.now() - tTotal,
          },
          routing: {
            intent: analysis.intent,
            effective_intent: effectiveIntent,
            speakers: validSpeakers,
            date_filter: analysis.date_filter,
            date_op: analysis.date_op,
            resolved_date: resolvedDate,
            resolved_dates: resolvedDates,
            meeting_count: analysis.meeting_count,
            candidate_cap: candidateCap,
            date_meeting_count: dateMeetingCount,
          },
          rewritten_queries: analysis.queries,
          query_vectors_count: allVecs.length,
          summary_hits: summaryResultsPerVec.map((r) => r.length),
          transcript_hits: transcriptResultsPerVec.map((r) => r.length),
          reference_hits: referenceResultsPerVec.map((r) => r.length),
          // false = 这次问题被判成钉在某次会议上（date/meeting），没检索参考文件
          reference_searched: wantReference,
          bm25_hits: bm25Hits.length,
          ilike_hits: ilikeHits.length,
          merged_count: merged.length,
          parent_chunks_used: parentRows.length,
          no_parent_fallback: noParentTranscript.length,
          reference_chunks_used: referenceChunks.length,
          chunks_total: Number(totalChunksRes[0]?.count ?? 0),
          chunks_with_embedding: Number(embeddedChunksRes[0]?.count ?? 0),
          recent_embed_errors: recentEmbedErrors,
          all_retrieved_chunks: merged.map((c) => ({
            type: c.chunk_type,
            date: c.meeting_date,
            speaker: c.speaker,
            section: c.section_title,
            parent_id: c.parent_id,
            text: (c.search_text ?? "").slice(0, 150),
            vec_distances: vecDistMap.get(c.id) ?? null,
          })),
          parent_chunks: parentRows.map((p) => ({
            id: p.id,
            date: p.meeting_date,
            speakers: p.speakers,
            hits: parentHits.get(p.id) ?? 1,
            text: p.content.slice(0, 300),
          })),
        };
      }

      controller.enqueue(send("done", donePayload));
      controller.close();
    },
  });

  return new Response(body, { headers: SSE_HEADERS });
}
