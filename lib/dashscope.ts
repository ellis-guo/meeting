import { extractJSON } from "@/lib/utils";

const CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const EMBED_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings";
const CHAT_MODEL = "qwen3.6-plus";
const EMBED_MODEL = "text-embedding-v3";
const EMBED_DIM = 1024;

export async function callDashScope(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
): Promise<string> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      enable_thinking: false,
    }),
  });
  if (!res.ok) throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return content;
}

export async function callDashScopeStream(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
  onToken: (text: string) => void,
  sep = "",
): Promise<string> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      enable_thinking: false,
      stream: true,
    }),
  });
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
          const safeEnd = Math.max(safeSent, fullText.length - (SEP_LEN - 1));
          if (safeEnd > safeSent) {
            onToken(fullText.slice(safeSent, safeEnd));
            safeSent = safeEnd;
          }
        }
      } catch { /* skip */ }
    }
  }

  if (!sepFound && !jsonMode && safeSent < fullText.length) {
    const remaining = fullText.slice(safeSent);
    if (remaining) onToken(remaining);
  }

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

export async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimension: EMBED_DIM }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} — ${await res.text()}`);
  return ((await res.json()).data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

export async function fetchEmbedding(text: string, apiKey: string): Promise<number[]> {
  return (await fetchEmbeddings([text], apiKey))[0];
}
