import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";

const ASK_SYSTEM_PROMPT = `你是一位项目助手，帮助用户理解会议讨论和项目进展。

规则：
1. 基于提供的 context 综合归纳，可跨多个片段整合信息，不得编造 context 中不存在的事实。
2. 若 context 完全无相关信息，直接回答"现有记录中未涉及该问题"。
3. 允许用预训练知识解释专业术语或补充背景，但须用"根据通用知识"明确标注。
4. 根据问题类型选择回答结构：
   - 进度/状态类 → 分阶段或分维度总结
   - 事实确认类 → 直接回答 + 来源
   - 讨论/决策类 → 列出各方观点 + 结论
5. 来源（说话人、时间点）自然嵌入行文，无需集中列在末尾。
6. 以结论性段落收尾，给出明确判断。
7. 项目主文档是最高优先级的背景知识，应优先用于回答进度、目标、成员、决策类问题；引用主文档内容时，sources 中填 chunk_type: "project_document"。
8. 仅输出合法 JSON，answer 字段可含换行符，不得包含 Markdown 代码块或任何 JSON 以外的内容。

输出 Schema：
{
  "answer": "string",
  "sources": [{ "chunk_type": "summary | transcript | project_document", "section_title": "string or null", "speaker": "string or null", "meeting_date": "string or null" }]
}`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No valid JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function callDashScope(systemPrompt: string, userMessage: string, apiKey: string): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        enable_thinking: false,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DashScope API error: ${res.status} — ${err}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return content;
}

type QueryAnalysis = {
  queries: string[];
  intent: "project" | "speaker" | "date" | "meeting" | "general";
  speakers: string[];
  date_filter: string | null;
};

const ANALYZE_SYSTEM_PROMPT = `你是查询分析助手。分析关于项目会议记录的问题，同时完成两件事：
1. 生成2个语义相同但措辞不同的改写版本，用于提升检索覆盖率
2. 分类意图并提取关键实体

意图分类（选一）：
- project：宏观项目问题（目标/成员/背景/整体进度），主文档和摘要已足够回答
- speaker：询问某个或某几个特定人物的发言、观点或行动
- date：问题中出现了具体日期（如"4月15日"、"上周三"），提取为 YYYY-MM-DD
- meeting：询问某次会议内容（含"上次/最近会议"），无具体日期
- general：跨会议综合问题、具体细节查询、或以上均不适合

字段说明：
- speakers：提取到的人物姓名数组，仅 intent=speaker 时填写，其余填 []；最多2个
- date_filter：intent=date 时填 YYYY-MM-DD，intent=meeting 且含"上次/最近"时填 "latest"，其余填 null

仅输出合法 JSON：
{
  "queries": ["改写版本1", "改写版本2"],
  "intent": "project | speaker | date | meeting | general",
  "speakers": [],
  "date_filter": null
}`;

const ANALYZE_FALLBACK: QueryAnalysis = { queries: [], intent: "general", speakers: [], date_filter: null };

async function analyzeQuery(question: string, apiKey: string): Promise<QueryAnalysis> {
  try {
    const raw = await callDashScope(ANALYZE_SYSTEM_PROMPT, `问题：${question}`, apiKey);
    const parsed = extractJSON(raw) as Record<string, unknown>;
    const intent = (["project", "speaker", "date", "meeting", "general"] as const)
      .find(i => i === parsed.intent) ?? "general";
    const queries = Array.isArray(parsed.queries)
      ? (parsed.queries as unknown[]).filter((q): q is string => typeof q === "string").slice(0, 2)
      : [];
    const speakers = Array.isArray(parsed.speakers)
      ? (parsed.speakers as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 2)
      : [];
    const date_filter = typeof parsed.date_filter === "string" ? parsed.date_filter : null;
    return { queries, intent, speakers, date_filter };
  } catch {
    return ANALYZE_FALLBACK;
  }
}

async function fetchEmbedding(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-v3",
        input: [text],
        dimension: 1024,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error: ${res.status} — ${err}`);
  }
  const data = await res.json();
  return (data.data as Array<{ embedding: number[] }>)[0].embedding;
}

type ChunkRow = {
  id: string;
  meeting_id: string;
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  meeting_date: string | null;
  search_text: string | null;
};

function rrfMerge(lists: ChunkRow[][], k = 60): ChunkRow[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((chunk, rank) => {
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
}

const ZH_STOP = new Set("了的地得是在有和与或不对于关于什么哪里哪谁如何怎么为什么吗呢啊呀吧嗯".split(""));

function extractKeywords(text: string): string[] {
  const segments = text
    .split(/[\s，。？！,.?!\r\n、：:；;「」【】()（）]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);
  const cjkRuns: string[] = [];
  let run = "";
  for (const ch of text) {
    const isCJK = ch >= "\u4e00" && ch <= "\u9fff";
    if (isCJK && !ZH_STOP.has(ch)) {
      run += ch;
    } else {
      if (run.length >= 2) cjkRuns.push(run);
      run = "";
    }
  }
  if (run.length >= 2) cjkRuns.push(run);
  const latinRuns = Array.from(text.matchAll(/[A-Za-z0-9_\-]{2,}/g), m => m[0]);
  return [...new Set([...segments, ...cjkRuns, ...latinRuns])].slice(0, 8);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "API key required. Please configure your DashScope API key in Settings." },
      { status: 401 },
    );
  }

  const { id: projectId } = await params;
  const { question } = await req.json();

  if (!question?.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, user_id: userId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const tTotal = Date.now();

  // Phase 1: analyze query (rewrite + intent + entities) + embed original — parallel
  let queryVec: number[];
  let analysis: QueryAnalysis;
  let analyzeMs = 0, embedOriginalMs = 0;
  try {
    [[analysis, analyzeMs], [queryVec, embedOriginalMs]] = await Promise.all([
      (async () => { const t = Date.now(); const r = await analyzeQuery(question, apiKey); return [r, Date.now() - t] as [QueryAnalysis, number]; })(),
      (async () => { const t = Date.now(); const r = await fetchEmbedding(question, apiKey); return [r, Date.now() - t] as [number[], number]; })(),
    ]);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  // Phase 2: embed rewrite variants + resolve date — parallel
  const tPhase2 = Date.now();
  const [variantVecs, resolvedDate] = await Promise.all([
    Promise.all(analysis.queries.map(q => fetchEmbedding(q, apiKey).catch(() => null))),
    analysis.date_filter === "latest"
      ? prisma.$queryRaw<[{ d: string | null }]>`
          SELECT MAX(meeting_date) as d FROM "Chunk" WHERE project_id = ${projectId}
        `.then(r => r[0]?.d ?? null)
      : Promise.resolve(
          analysis.date_filter && /^\d{4}-\d{2}-\d{2}$/.test(analysis.date_filter)
            ? analysis.date_filter
            : null
        ),
  ]);
  const embedVariantsMs = Date.now() - tPhase2;

  const allVecs = [queryVec, ...variantVecs.filter((v): v is number[] => v !== null)];
  const allVecStrs = allVecs.map(v => `[${v.join(",")}]`);

  // Phase 3: intent-based retrieval
  const tRetrieval = Date.now();

  // Determine effective intent with fallback rules
  const validSpeakers = analysis.speakers.filter(s => s.trim().length > 0).slice(0, 2);
  const effectiveIntent =
    analysis.intent === "speaker" && validSpeakers.length === 0 ? "general"
    : analysis.intent === "date" && !resolvedDate ? "general"
    : analysis.intent;

  let summaryResultsPerVec: ChunkRow[][] = [];
  let transcriptResultsPerVec: ChunkRow[][] = [];
  let bm25Hits: ChunkRow[] = [];
  let ilikeHits: ChunkRow[] = [];

  if (effectiveIntent === "project") {
    // Project doc (always in context) + summary chunks only
    summaryResultsPerVec = await Promise.all(allVecStrs.map(vecStr =>
      prisma.$queryRaw<ChunkRow[]>`
        SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
        FROM "Chunk"
        WHERE project_id = ${projectId}
          AND chunk_type = 'summary'
          AND embedding IS NOT NULL
          AND embedding <=> ${vecStr}::vector < 0.5
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT 5
      `
    ));

  } else if (effectiveIntent === "speaker") {
    // Transcript chunks filtered by speaker — no distance threshold, no summary
    const speakerPattern = validSpeakers.map(escapeRegex).join("|");
    transcriptResultsPerVec = await Promise.all(allVecStrs.map(vecStr =>
      prisma.$queryRaw<ChunkRow[]>`
        SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
        FROM "Chunk"
        WHERE project_id = ${projectId}
          AND chunk_type = 'transcript'
          AND embedding IS NOT NULL
          AND speaker ~* ${speakerPattern}
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT 10
      `
    ));

  } else if (effectiveIntent === "date" || (effectiveIntent === "meeting" && resolvedDate)) {
    // Summary + transcript filtered by resolved date (non-null guaranteed here)
    [summaryResultsPerVec, transcriptResultsPerVec] = await Promise.all([
      Promise.all(allVecStrs.map(vecStr =>
        prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND meeting_date = ${resolvedDate}
            AND embedding IS NOT NULL
            AND embedding <=> ${vecStr}::vector < 0.5
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 5
        `
      )),
      Promise.all(allVecStrs.map(vecStr =>
        prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND meeting_date = ${resolvedDate}
            AND embedding IS NOT NULL
            AND embedding <=> ${vecStr}::vector < 0.5
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 10
        `
      )),
    ]);

  } else if (effectiveIntent === "meeting") {
    // Summary + transcript, no date filter, no BM25/regex
    [summaryResultsPerVec, transcriptResultsPerVec] = await Promise.all([
      Promise.all(allVecStrs.map(vecStr =>
        prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND embedding IS NOT NULL
            AND embedding <=> ${vecStr}::vector < 0.5
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 5
        `
      )),
      Promise.all(allVecStrs.map(vecStr =>
        prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND embedding IS NOT NULL
            AND embedding <=> ${vecStr}::vector < 0.5
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 10
        `
      )),
    ]);

  } else {
    // general: full 4-way retrieval
    const keywords = extractKeywords(question);
    const keywordPattern = keywords.length > 0 ? keywords.map(escapeRegex).join("|") : null;

    [summaryResultsPerVec, transcriptResultsPerVec, bm25Hits, ilikeHits] = await Promise.all([
      Promise.all(allVecStrs.map(vecStr =>
        prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'summary'
            AND embedding IS NOT NULL
            AND embedding <=> ${vecStr}::vector < 0.5
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 5
        `
      )),
      Promise.all(allVecStrs.map(vecStr =>
        prisma.$queryRaw<ChunkRow[]>`
          SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
          FROM "Chunk"
          WHERE project_id = ${projectId}
            AND chunk_type = 'transcript'
            AND embedding IS NOT NULL
            AND embedding <=> ${vecStr}::vector < 0.5
          ORDER BY embedding <=> ${vecStr}::vector
          LIMIT 10
        `
      )),
      prisma.$queryRaw<ChunkRow[]>`
        SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
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
            SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
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

  const merged = rrfMerge([
    ...summaryResultsPerVec,
    ...transcriptResultsPerVec,
    bm25Hits,
    ilikeHits,
  ]).slice(0, 8);

  const projectDoc = project.document ? decryptJSON(project.document) : null;

  const contextParts: string[] = [];
  if (projectDoc) {
    contextParts.push(`项目主文档：\n${JSON.stringify(projectDoc, null, 2)}`);
  }
  if (merged.length > 0) {
    const chunkTexts = merged.map((c) =>
      `[${c.meeting_date ?? "日期未知"} · ${c.section_title ?? c.speaker ?? "片段"}]\n${c.search_text ?? ""}`
    );
    contextParts.push(`会议记录片段：\n${chunkTexts.join("\n\n---\n\n")}`);
  }

  const userMessage = `${contextParts.join("\n\n===\n\n")}\n\n问题：${question}`;

  const tAnswer = Date.now();
  let raw_answer: string;
  try {
    raw_answer = await callDashScope(ASK_SYSTEM_PROMPT, userMessage, apiKey);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
  const answerMs = Date.now() - tAnswer;

  let parsed: { answer?: string; sources?: Array<{ chunk_type?: string; section_title?: string | null; speaker?: string | null; meeting_date?: string | null }> } = {};
  try {
    parsed = extractJSON(raw_answer) as typeof parsed;
  } catch {
    return NextResponse.json({ error: "Failed to parse model response", raw: raw_answer }, { status: 502 });
  }

  const llmSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources = llmSources.map((s) => {
    if (s.chunk_type === "project_document") {
      return { meeting_id: null, chunk_type: "project_document", section_title: s.section_title ?? null, speaker: null, meeting_date: null };
    }
    const match = merged.find((c) =>
      c.meeting_date === s.meeting_date &&
      (c.section_title === s.section_title || c.speaker === s.speaker)
    );
    return {
      meeting_id: match?.meeting_id ?? null,
      chunk_type: s.chunk_type ?? "summary",
      section_title: s.section_title ?? null,
      speaker: s.speaker ?? null,
      meeting_date: s.meeting_date ?? null,
    };
  });

  const [totalChunksRes, embeddedChunksRes] = await Promise.all([
    prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE project_id = ${projectId}`,
    prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE project_id = ${projectId} AND embedding IS NOT NULL`,
  ]);
  const totalChunks = Number(totalChunksRes[0]?.count ?? 0);
  const embeddedChunks = Number(embeddedChunksRes[0]?.count ?? 0);

  const projectMeetingIds = await prisma.meeting.findMany({
    where: { project_id: projectId },
    select: { id: true },
  });
  const meetingIds = projectMeetingIds.map((m) => m.id);
  const embeddingLogs = meetingIds.length > 0
    ? await prisma.processingLog.findMany({
        where: { meeting_id: { in: meetingIds }, level: "error" },
        orderBy: { created_at: "desc" },
        take: 5,
      })
    : [];
  const recentEmbedErrors = embeddingLogs.map((log) => {
    try { return decryptJSON<Record<string, unknown>>(log.context); } catch { return log.context; }
  });

  const citationCounts = { project_document: 0, summary: 0, transcript: 0 };
  for (const s of sources) {
    const t = s.chunk_type as keyof typeof citationCounts;
    if (t in citationCounts) citationCounts[t]++;
  }

  const _debug = {
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
    },
    rewritten_queries: analysis.queries,
    query_vectors_count: allVecs.length,
    summary_hits: summaryResultsPerVec.map(r => r.length),
    transcript_hits: transcriptResultsPerVec.map(r => r.length),
    bm25_hits: bm25Hits.length,
    ilike_hits: ilikeHits.length,
    merged_count: merged.length,
    has_project_doc: !!projectDoc,
    chunks_total: totalChunks,
    chunks_with_embedding: embeddedChunks,
    recent_embed_errors: recentEmbedErrors,
    all_retrieved_chunks: merged.map((c) => ({
      type: c.chunk_type,
      date: c.meeting_date,
      speaker: c.speaker,
      section: c.section_title,
      text: (c.search_text ?? "").slice(0, 150),
    })),
  };

  return NextResponse.json({ answer: parsed.answer ?? raw_answer, sources, _debug });
}
