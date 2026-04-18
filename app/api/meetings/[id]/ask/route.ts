import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt, decryptJSON } from "@/lib/crypto";

const ASK_SYSTEM_PROMPT = `你是一位会议助手，根据提供的会议摘要和逐字稿回答用户问题。
规则：
1. 仅基于提供的 context 回答，不推断或补充。
2. 若 context 中无相关信息，直接说"现有会议记录中未涉及该问题"。
3. 回答简洁，引用具体说话人或段落作为依据。
4. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。

输出 Schema：
{
  "answer": "string",
  "sources": [{ "chunk_type": "string", "section_title": "string or null", "speaker": "string or null", "line_start": "number or null" }]
}`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No valid JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function callDashScope(systemPrompt: string, userMessage: string): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
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

async function fetchEmbedding(text: string): Promise<number[]> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: meetingId } = await params;
  const { question } = await req.json();

  if (!question?.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const raw = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!raw) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const transcript = decrypt(raw.transcript);
  const summary = decryptJSON(raw.summary);

  const estimatedTokens = Math.ceil(transcript.length / 1.5);

  let answer: unknown;

  if (estimatedTokens < 50_000) {
    // Full-text path: send everything to LLM
    const context = `会议摘要：\n${JSON.stringify(summary, null, 2)}\n\n逐字稿：\n${transcript}`;
    const userMessage = `context：\n${context}\n\n问题：${question}`;
    let raw_answer: string;
    try {
      raw_answer = await callDashScope(ASK_SYSTEM_PROMPT, userMessage);
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 502 });
    }
    try {
      answer = extractJSON(raw_answer);
    } catch {
      return NextResponse.json({ error: "Failed to parse model response", raw: raw_answer }, { status: 502 });
    }
  } else {
    // RAG path: vector search on this meeting's transcript chunks
    let queryVec: number[];
    try {
      queryVec = await fetchEmbedding(question);
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 502 });
    }

    const vecStr = `[${queryVec.join(",")}]`;
    type ChunkRow = {
      id: string;
      chunk_type: string;
      section_title: string | null;
      speaker: string | null;
      line_start: number | null;
      search_text: string | null;
    };
    const hits = await prisma.$queryRaw<ChunkRow[]>`
      SELECT id, chunk_type, section_title, speaker, line_start, search_text
      FROM "Chunk"
      WHERE meeting_id = ${meetingId}
        AND chunk_type = 'transcript'
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT 10
    `;

    const contextParts = hits.map((c) =>
      `[${c.speaker ?? "未知"}] ${c.search_text ?? ""}`
    );
    const userMessage = `相关逐字稿片段：\n${contextParts.join("\n\n---\n\n")}\n\n问题：${question}`;
    let raw_answer: string;
    try {
      raw_answer = await callDashScope(ASK_SYSTEM_PROMPT, userMessage);
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 502 });
    }
    try {
      answer = extractJSON(raw_answer);
    } catch {
      return NextResponse.json({ error: "Failed to parse model response", raw: raw_answer }, { status: 502 });
    }
  }

  return NextResponse.json(answer);
}
