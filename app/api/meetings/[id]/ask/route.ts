import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decrypt, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { addLineNumbers } from "@/lib/utils";

const SOURCES_SEP = "%%SOURCES%%";

const FULL_TEXT_ASK_PROMPT = `你是一位会议助手，帮助用户理解会议讨论内容。

规则：
1. 基于提供的完整会议摘要和逐字稿综合回答，可跨多个部分整合信息，不得编造内容中不存在的事实。
2. 若 context 完全无相关信息，直接回答"会议记录中未涉及该问题"。
3. 根据问题类型选择回答结构：
   - 事实/结论类 → 直接回答 + 具体细节
   - 讨论过程类 → 列出各方观点 + 结论
   - 人物发言类 → 引用具体原话或转述，说明发言人
4. 回答正文中不要嵌入来源标注（如"说话人xxx，行xx"）；来源统一在 %%SOURCES%% 后列出。
5. 若会议对该话题存在明确的疑问、争议或尚未达成共识，在回答中如实指出，不要将其平滑为结论。
6. 以结论性句子收尾，给出明确判断；若存在未解决问题，结尾说明待确认的事项。
7. 若问题涉及会议未覆盖的通用知识（如行业规范、工具用法等），可在回答末尾补充，但必须另起一段，以"【根据通用知识】"开头，与会议内容严格区分。

输出格式（严格遵守，分两部分）：
第一部分：完整回答文字（可含换行和 **粗体**）
第二部分：另起一行写 %%SOURCES%%，然后输出来源 JSON 数组：
[{"chunk_type":"summary 或 transcript","section_title":"字符串或null","speaker":"字符串或null","line_start":数字或null}]`;

const RAG_ASK_PROMPT = `你是一位会议助手，根据提供的会议逐字稿片段回答用户问题。

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
  if (start === -1 || end === -1 || end <= start) throw new Error("No valid JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}

async function callDashScopeStream(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
  onToken: (text: string) => void,
  sep = "",
): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        enable_thinking: false,
        stream: true,
      }),
    },
  );
  if (!res.ok) throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buf = "";
  const SEP_LEN = sep.length;
  let safeSent = 0;
  let sepFound = false;
  let jsonMode = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> })
          .choices?.[0]?.delta?.content ?? "";
        if (!chunk) continue;
        fullText += chunk;

        if (SEP_LEN === 0) { onToken(chunk); continue; }

        // Detect JSON-mode (LLM ignored separator format, output {"answer":...} instead)
        if (!jsonMode && safeSent === 0 && fullText.trimStart().startsWith("{")) {
          jsonMode = true;
        }
        if (jsonMode || sepFound) continue;

        const searchFrom = Math.max(0, safeSent - (SEP_LEN - 1));
        const sepIdx = fullText.indexOf(sep, searchFrom);
        if (sepIdx !== -1) {
          const toSend = fullText.slice(safeSent, sepIdx);
          if (toSend) onToken(toSend);
          safeSent = sepIdx;
          sepFound = true;
        } else {
          // Keep SEP_LEN-1 chars buffered to handle separator split across tokens
          const safeEnd = Math.max(safeSent, fullText.length - (SEP_LEN - 1));
          if (safeEnd > safeSent) {
            onToken(fullText.slice(safeSent, safeEnd));
            safeSent = safeEnd;
          }
        }
      } catch { /* skip */ }
    }
  }

  // Flush remaining answer text when no separator in output
  if (!sepFound && !jsonMode && safeSent < fullText.length) {
    const remaining = fullText.slice(safeSent);
    if (remaining) onToken(remaining);
  }

  // JSON mode: extract answer from JSON object and send as single token
  if (jsonMode) {
    try {
      const parsed = extractJSON(fullText) as { answer?: string };
      if (parsed.answer) onToken(parsed.answer);
    } catch {
      onToken(fullText.trim());
    }
  }

  return fullText;
}

async function callDashScope(systemPrompt: string, userMessage: string, apiKey: string): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        enable_thinking: false,
      }),
    },
  );
  if (!res.ok) throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);
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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "text-embedding-v3", input: [text], dimension: 1024 }),
    },
  );
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  return (data.data as Array<{ embedding: number[] }>)[0].embedding;
}

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

  if (!question?.trim()) {
    const encoder = new TextEncoder();
    return new Response(
      encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "question is required" })}\n\n`),
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
