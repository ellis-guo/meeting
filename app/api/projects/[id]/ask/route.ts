import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";

const ASK_SYSTEM_PROMPT = `你是一位项目助手，根据提供的项目文档和会议记录片段回答用户问题。
规则：
1. 仅基于提供的 context 回答，不推断或补充。
2. 若 context 中无相关信息，直接说"现有会议记录中未涉及该问题"。
3. 回答简洁，引用具体会议日期或说话人作为依据。
4. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。

输出 Schema：
{
  "answer": "string",
  "sources": [{ "chunk_type": "string", "section_title": "string or null", "speaker": "string or null", "meeting_date": "string or null" }]
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

  // Embed question
  let queryVec: number[];
  try {
    queryVec = await fetchEmbedding(question, apiKey);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  const vecStr = `[${queryVec.join(",")}]`;

  // Three-way parallel retrieval
  const [summaryHits, transcriptHits, bm25Hits] = await Promise.all([
    prisma.$queryRaw<ChunkRow[]>`
      SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
      FROM "Chunk"
      WHERE project_id = ${projectId}
        AND chunk_type = 'summary'
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT 5
    `,
    prisma.$queryRaw<ChunkRow[]>`
      SELECT id, meeting_id, chunk_type, section_title, speaker, meeting_date, search_text
      FROM "Chunk"
      WHERE project_id = ${projectId}
        AND chunk_type = 'transcript'
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT 10
    `,
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
  ]);

  const merged = rrfMerge([summaryHits, transcriptHits, bm25Hits]).slice(0, 8);

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

  let raw_answer: string;
  try {
    raw_answer = await callDashScope(ASK_SYSTEM_PROMPT, userMessage, apiKey);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  let parsed: { answer?: string } = {};
  try {
    parsed = extractJSON(raw_answer) as { answer?: string };
  } catch {
    return NextResponse.json({ error: "Failed to parse model response", raw: raw_answer }, { status: 502 });
  }

  const sources = merged.map((c) => ({
    meeting_id: c.meeting_id,
    chunk_type: c.chunk_type,
    section_title: c.section_title,
    speaker: c.speaker,
    meeting_date: c.meeting_date,
  }));

  return NextResponse.json({ answer: parsed.answer ?? raw_answer, sources });
}
