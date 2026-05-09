import { extractJSON } from "@/lib/utils";

const CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const EMBED_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings";
export const CHAT_MODEL = "qwen3.6-plus";
export const FAST_CHAT_MODEL = "qwen3.6-flash";
const EMBED_MODEL = "text-embedding-v3";
const EMBED_DIM = 1024;

export type DashScopeUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export async function callDashScope(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
  model: string = CHAT_MODEL,
): Promise<{ content: string; usage: DashScopeUsage | null }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
      enable_thinking: false,
    }),
  });
  if (!res.ok) throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return { content, usage: (data.usage as DashScopeUsage) ?? null };
}

export async function callDashScopeStream(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
  onToken: (text: string) => void,
  sep = "",
  model: string = CHAT_MODEL,
): Promise<{ fullText: string; usage: DashScopeUsage | null }> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
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
  let lastUsage: DashScopeUsage | null = null;

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
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: DashScopeUsage;
        };
        if (parsed.usage) lastUsage = parsed.usage;
        const chunk = parsed.choices?.[0]?.delta?.content ?? "";
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

  return { fullText, usage: lastUsage };
}

export async function fetchEmbeddings(texts: string[], apiKey: string): Promise<{ embeddings: number[][]; usage: DashScopeUsage | null }> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimension: EMBED_DIM }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} — ${await res.text()}`);
  const json = await res.json();
  return {
    embeddings: (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding),
    usage: (json.usage as DashScopeUsage) ?? null,
  };
}

export async function fetchEmbedding(text: string, apiKey: string): Promise<{ embedding: number[]; usage: DashScopeUsage | null }> {
  const { embeddings, usage } = await fetchEmbeddings([text], apiKey);
  return { embedding: embeddings[0], usage };
}
