import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { extractKeywords } from "@/lib/jieba";
import { callDashScope, callDashScopeStream, fetchEmbedding, fetchEmbeddings, FAST_CHAT_MODEL, DashScopeUsage } from "@/lib/dashscope";
import { extractJSON } from "@/lib/utils";
import { ASK_SYSTEM_PROMPT, ANALYZE_SYSTEM_PROMPT } from "@/lib/prompts";
import { Prisma } from "@/app/generated/prisma/client";
import { checkRateLimit } from "@/lib/ratelimit";

const SOURCES_SEP = "%%SOURCES%%";

type QueryAnalysis = {
  queries: string[];
  intent: "project" | "speaker" | "date" | "meeting" | "audit" | "general";
  speakers: string[];
  date_filter: string | null;
  meeting_count: number;
};

const ANALYZE_FALLBACK: QueryAnalysis = {
  queries: [],
  intent: "general",
  speakers: [],
  date_filter: null,
  meeting_count: 1,
};

async function analyzeQuery(
  question: string,
  apiKey: string,
  today: string,
): Promise<{ result: QueryAnalysis; usage: DashScopeUsage | null }> {
  try {
    const { content: raw, usage } = await callDashScope(
      ANALYZE_SYSTEM_PROMPT,
      `当前日期：${today}\n问题：${question}`,
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
    const meeting_count =
      typeof parsed.meeting_count === "number" && parsed.meeting_count >= 1
        ? Math.min(Math.round(parsed.meeting_count), 5)
        : 1;
    return { result: { queries, intent, speakers, date_filter, meeting_count }, usage };
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

  // Safety gate: any meeting with diff_status='pending' blocks project-level
  // questions until the user confirms or dismisses those updates.
  const pendingDiffCount = await prisma.meeting.count({
    where: { project_id: projectId, diff_status: "pending" },
  });
  if (pendingDiffCount > 0) {
    return NextResponse.json(
      {
        error: `请先处理 ${pendingDiffCount} 条主文档更新建议后再提问`,
        pending_diff_count: pendingDiffCount,
      },
      { status: 409 },
    );
  }

  const tTotal = Date.now();
  const today = new Date().toISOString().slice(0, 10);

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
        const { result, usage } = await analyzeQuery(question, apiKey, today);
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
        : Promise.resolve(
            analysis.date_filter &&
              /^\d{4}-\d{2}-\d{2}$/.test(analysis.date_filter)
              ? analysis.date_filter
              : null,
          ),
      // Multi-date: top-N distinct meeting_dates for "最近N次"
      analysis.date_filter === "latest" && analysis.meeting_count > 1
        ? prisma.$queryRaw<Array<{ d: string }>>`
          SELECT DISTINCT meeting_date as d FROM "Chunk"
          WHERE project_id = ${projectId} AND meeting_date IS NOT NULL
          ORDER BY meeting_date DESC
          LIMIT ${analysis.meeting_count}
        `.then((r) => (r.length > 0 ? r.map((row) => row.d) : null))
        : Promise.resolve(null as string[] | null),
      analysis.intent === "date" &&
      analysis.date_filter &&
      /^\d{4}-\d{2}-\d{2}$/.test(analysis.date_filter)
        ? prisma.$queryRaw<[{ cnt: bigint }]>`
          SELECT COUNT(DISTINCT meeting_id)::int AS cnt FROM "Chunk"
          WHERE project_id = ${projectId} AND meeting_date = ${analysis.date_filter}
        `.then((r) => Number(r[0]?.cnt ?? 1))
        : Promise.resolve(1),
    ]);
  const embedVariantsMs = Date.now() - tPhase2;

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

  let summaryResultsPerVec: ChunkRow[][] = [];
  let transcriptResultsPerVec: ChunkRow[][] = [];
  let bm25Hits: ChunkRow[] = [];
  let ilikeHits: ChunkRow[] = [];

  if (effectiveIntent === "project") {
    // Project doc (always in context) + summary chunks only
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
            AND meeting_date = ${resolvedDate}
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
            AND meeting_date = ${resolvedDate}
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
        prisma.$queryRaw<ChunkRow[]>`
        SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id
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
            SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text, parent_id
            FROM "Chunk"
            WHERE project_id = ${projectId}
              AND search_text IS NOT NULL
              AND search_text ~* ${keywordPattern}
            LIMIT 5
          `
          : Promise.resolve([] as ChunkRow[]),
      ]);
  }

  const retrievalMs = Date.now() - tRetrieval;

  const vecDistMap = new Map<string, (number | null)[]>();
  const numVecs = allVecs.length;
  for (const lists of [summaryResultsPerVec, transcriptResultsPerVec]) {
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
    bm25Hits,
    ilikeHits,
  ]);
  const merged = cliffCutoff(rrfChunks, rrfScores, candidateCap);

  // Parent-child: group transcript chunks by parent_id, fetch parents sorted by hit count
  const parentHits = new Map<string, number>();
  const summaryChunks: ChunkRow[] = [];
  const noParentTranscript: ChunkRow[] = [];

  for (const chunk of merged) {
    if (chunk.chunk_type === "summary") {
      summaryChunks.push(chunk);
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

  const projectDoc = project.document
    ? decryptJSON<Record<string, unknown>>(project.document)
    : null;

  const contextParts: string[] = [];
  if (projectDoc) {
    if (effectiveIntent === "audit") {
      const { checklist, ...docWithoutChecklist } = projectDoc;
      contextParts.push(
        `项目主文档：\n${JSON.stringify(docWithoutChecklist, null, 2)}`,
      );
      if (Array.isArray(checklist) && checklist.length > 0) {
        contextParts.push(
          `需求 Checklist（请逐条对照会议记录评估完成状态）：\n${JSON.stringify(checklist, null, 2)}`,
        );
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { checklist: _omit, ...docWithoutChecklist } = projectDoc;
      contextParts.push(
        `项目主文档：\n${JSON.stringify(docWithoutChecklist, null, 2)}`,
      );
    }
  }

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

  const userMessage = `${contextParts.join("\n\n===\n\n")}\n\n问题：${question}`;

  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const body = new ReadableStream({
    async start(controller) {
      // Fire stats queries in parallel with LLM stream — meetingDateIndex
      // is needed when resolving sources after the stream finishes; the rest
      // are only used in _debug. ProcessingLog uses subquery to avoid a
      // separate meeting-id round-trip.
      const statsPromise = Promise.all([
        prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE project_id = ${projectId}`,
        prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE project_id = ${projectId} AND embedding IS NOT NULL`,
        prisma.$queryRaw<Array<{ meeting_id: string; meeting_date: string }>>`
          SELECT DISTINCT ON (meeting_date) meeting_id, meeting_date
          FROM "Chunk"
          WHERE project_id = ${projectId} AND meeting_date IS NOT NULL
          ORDER BY meeting_date
        `,
        prisma.$queryRaw<Array<{ context: string }>>`
          SELECT context FROM "ProcessingLog"
          WHERE meeting_id IN (SELECT id FROM "Meeting" WHERE project_id = ${projectId})
            AND level = 'error'
          ORDER BY created_at DESC
          LIMIT 5
        `,
      ]);

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

      const [totalChunksRes, embeddedChunksRes, meetingDateRows, embeddingLogs] =
        await statsPromise;
      const totalChunks = Number(totalChunksRes[0]?.count ?? 0);
      const embeddedChunks = Number(embeddedChunksRes[0]?.count ?? 0);
      const meetingDateIndex = new Map(
        meetingDateRows.map((r) => [r.meeting_date, r.meeting_id]),
      );
      const recentEmbedErrors = embeddingLogs.map((log) => {
        try {
          return decryptJSON<Record<string, unknown>>(log.context);
        } catch {
          return log.context;
        }
      });

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
        if (s.chunk_type === "project_document") {
          return {
            meeting_id: null,
            chunk_type: "project_document",
            section_title: s.section_title ?? null,
            speaker: null,
            meeting_date: null,
          };
        }
        const meetingId = s.meeting_date
          ? (meetingDateIndex.get(s.meeting_date) ?? null)
          : null;
        return {
          meeting_id: meetingId,
          chunk_type: s.chunk_type ?? "summary",
          section_title: s.section_title ?? null,
          speaker: s.speaker ?? null,
          meeting_date: s.meeting_date ?? null,
        };
      });

      const citationCounts = { project_document: 0, summary: 0, transcript: 0 };
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

      const _debug = {
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
        bm25_hits: bm25Hits.length,
        ilike_hits: ilikeHits.length,
        merged_count: merged.length,
        parent_chunks_used: parentRows.length,
        no_parent_fallback: noParentTranscript.length,
        has_project_doc: !!projectDoc,
        has_checklist:
          effectiveIntent === "audit" &&
          Array.isArray(projectDoc?.checklist) &&
          (projectDoc.checklist as unknown[]).length > 0,
        chunks_total: totalChunks,
        chunks_with_embedding: embeddedChunks,
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

      const donePayload: Record<string, unknown> = { sources };
      if (process.env.NODE_ENV !== "production") donePayload._debug = _debug;
      controller.enqueue(send("done", donePayload));
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
