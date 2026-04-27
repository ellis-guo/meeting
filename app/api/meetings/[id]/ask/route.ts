import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decrypt, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { addLineNumbers, extractJSON } from "@/lib/utils";
import { callDashScope, callDashScopeStream, fetchEmbedding } from "@/lib/dashscope";
import { FULL_TEXT_ASK_PROMPT, RAG_ASK_PROMPT } from "@/lib/prompts";
import { checkRateLimit } from "@/lib/ratelimit";

const SOURCES_SEP = "%%SOURCES%%";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    const encoder = new TextEncoder();
    return new Response(
      encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Unauthorized" })}\n\n`),
      { status: 401, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const rl = checkRateLimit(userId, "POST", "POST:/api/meetings/ask");
  if (!rl.allowed) {
    const encoder = new TextEncoder();
    return new Response(
      encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "请求过于频繁，请稍后再试（每分钟最多 20 次）" })}\n\n`),
      { status: 429, headers: { "Content-Type": "text/event-stream", "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    const encoder = new TextEncoder();
    return new Response(
      encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "API key required. Please configure your DashScope API key in Settings." })}\n\n`),
      { status: 401, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const { id: meetingId } = await params;
  const { question } = await req.json();

  if (!question?.trim() || question.length > 2000) {
    const encoder = new TextEncoder();
    const error = !question?.trim() ? "question is required" : "question too long (max 2000 characters)";
    return new Response(
      encoder.encode(`event: error\ndata: ${JSON.stringify({ error })}\n\n`),
      { status: 400, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const raw = await prisma.meeting.findFirst({ where: { id: meetingId, user_id: userId } });
  if (!raw) {
    const encoder = new TextEncoder();
    return new Response(
      encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Meeting not found" })}\n\n`),
      { status: 404, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const transcript = decrypt(raw.transcript);
  const summary = decryptJSON(raw.summary);
  const estimatedTokens = Math.ceil(transcript.length / 1.5);
  const tTotal = Date.now();

  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const body = new ReadableStream({
    async start(controller) {
      try {
        if (estimatedTokens < 50_000) {
          // Full-text path: stream LLM tokens to client
          const numberedTranscript = addLineNumbers(transcript);
          const context = `会议摘要：\n${JSON.stringify(summary, null, 2)}\n\n逐字稿（含行号）：\n${numberedTranscript}`;
          const userMessage = `context：\n${context}\n\n问题：${question}`;

          const tAnswer = Date.now();
          let fullText = "";
          try {
            fullText = await callDashScopeStream(FULL_TEXT_ASK_PROMPT, userMessage, apiKey, (token) => {
              controller.enqueue(send("token", { text: token }));
            }, SOURCES_SEP);
          } catch (e) {
            controller.enqueue(send("error", { error: String(e) }));
            controller.close();
            return;
          }
          const answerMs = Date.now() - tAnswer;

          // Parse sources from the separator section
          const sepIdx = fullText.indexOf(SOURCES_SEP);
          let sources: unknown[] = [];
          if (sepIdx !== -1) {
            const sourcesPart = fullText.slice(sepIdx + SOURCES_SEP.length).trim();
            try {
              const parsed = JSON.parse(sourcesPart);
              sources = Array.isArray(parsed) ? parsed : [];
            } catch { /* no valid sources */ }
          }

          const _debug = {
            path: "full_text",
            estimated_tokens: estimatedTokens,
            timings_ms: { answer_llm: answerMs, total: Date.now() - tTotal },
          };

          controller.enqueue(send("done", { sources, _debug }));
          controller.close();

        } else {
          // RAG fallback — kept as-is, emit via SSE for API consistency
          let queryVec: number[];
          const tEmbed = Date.now();
          try {
            queryVec = await fetchEmbedding(question, apiKey);
          } catch (e) {
            controller.enqueue(send("error", { error: String(e) }));
            controller.close();
            return;
          }
          const embedMs = Date.now() - tEmbed;

          const vecStr = `[${queryVec.join(",")}]`;
          type ChunkRow = {
            id: string; chunk_type: string; section_title: string | null;
            speaker: string | null; line_start: number | null; search_text: string | null;
          };

          const tRetrieval = Date.now();
          const hits = await prisma.$queryRaw<ChunkRow[]>`
            SELECT id, chunk_type, section_title, speaker, line_start, search_text
            FROM "Chunk"
            WHERE meeting_id = ${meetingId}
              AND chunk_type = 'transcript'
              AND embedding IS NOT NULL
            ORDER BY embedding <=> ${vecStr}::vector
            LIMIT 10
          `;
          const retrievalMs = Date.now() - tRetrieval;

          const [totalChunksRes, embeddedChunksRes] = await Promise.all([
            prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE meeting_id = ${meetingId}`,
            prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*)::int AS count FROM "Chunk" WHERE meeting_id = ${meetingId} AND embedding IS NOT NULL`,
          ]);
          const totalChunks = Number(totalChunksRes[0]?.count ?? 0);
          const embeddedChunks = Number(embeddedChunksRes[0]?.count ?? 0);

          const contextParts = hits.map((c) => `[${c.speaker ?? "未知"}] ${c.search_text ?? ""}`);
          const userMessage = `相关逐字稿片段：\n${contextParts.join("\n\n---\n\n")}\n\n问题：${question}`;

          const tAnswer = Date.now();
          let raw_answer: string;
          try {
            raw_answer = await callDashScope(RAG_ASK_PROMPT, userMessage, apiKey);
          } catch (e) {
            controller.enqueue(send("error", { error: String(e) }));
            controller.close();
            return;
          }
          const answerMs = Date.now() - tAnswer;

          let parsed: { answer?: string; sources?: unknown[] } = {};
          try {
            parsed = extractJSON(raw_answer) as typeof parsed;
          } catch {
            controller.enqueue(send("error", { error: "Failed to parse model response" }));
            controller.close();
            return;
          }

          const _debug = {
            path: "rag",
            transcript_hits: hits.length,
            chunks_total: totalChunks,
            chunks_with_embedding: embeddedChunks,
            timings_ms: { embed: embedMs, retrieval: retrievalMs, answer_llm: answerMs, total: Date.now() - tTotal },
            all_retrieved_chunks: hits.map((c) => ({
              type: c.chunk_type, speaker: c.speaker, section: c.section_title,
              line_start: c.line_start, text: (c.search_text ?? "").slice(0, 150),
            })),
          };

          controller.enqueue(send("token", { text: parsed.answer ?? raw_answer }));
          controller.enqueue(send("done", { sources: parsed.sources ?? [], _debug }));
          controller.close();
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
