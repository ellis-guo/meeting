import { extractJSON } from "@/lib/utils";

const CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const EMBED_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings";
// 默认模型 = 用户直接看到输出的地方（问答生成）。实测 flash 在多步推理题上
// 会自相矛盾（「感冒是否在 3.20 之前」：证据写着 3.19，结论却说"不是之前"），
// 而它的首字时间与 plus 基本打平（中位 1089 vs 1209ms）——优势在吞吐，
// 而用户感知的是首字。拿推理可靠性换一个感知不到的吞吐，不划算。
export const CHAT_MODEL = "qwen3.6-plus";
// 用于「失败可检测」的环节：结构化抽取有 schema 校验兜底，后台任务用户不直接看。
// 摘要生成实测 3 份真实逐字稿：JSON 全有效、行号越界率 0%、锚点抽查更准，快 2.3×。
export const FAST_CHAT_MODEL = "qwen3.6-flash";
const EMBED_MODEL = "text-embedding-v3";
const EMBED_DIM = 1024;

// 超时。在这之前整条链路一个超时都没有：上游挂住（不断开、也不发数据）时
// fetch 会永远等下去，而后台任务正持着队列租约，心跳续租让它看起来"还在跑"——
// 一个卡死的任务能把那一类任务堵到天荒地老，且没有任何报错。
//
// 分档的依据是"什么算不正常"：
// - 非流式调用看**总时长**，它要么给完整 JSON 要么不给，中间没有可观察的进展。
// - 流式调用不能用总时长——正常的长回答会被拦腰砍掉。要看的是**空闲时长**：
//   多久没有新 token。再加一个总上限兜底，值取 300s 是为了和 nginx 的
//   `proxy_read_timeout 300s` 对齐：那边一断，这边再算下去也没人收。
// - embedding 是批量小请求，慢就是不对。
// 都可以用环境变量覆盖：一是上游变慢时不用重新构建就能调，二是这几个值
// 按秒计，写测试时必须能压到毫秒级才验得动。非法值（空、非数、非正）一律回落
// 到默认，不让一个打错的环境变量把超时变成 0（那等于每次调用立刻中止）。
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const CHAT_TIMEOUT_MS = envMs("DASHSCOPE_CHAT_TIMEOUT_MS", 180_000);
const STREAM_IDLE_TIMEOUT_MS = envMs("DASHSCOPE_STREAM_IDLE_TIMEOUT_MS", 60_000);
const STREAM_HARD_CAP_MS = envMs("DASHSCOPE_STREAM_HARD_CAP_MS", 300_000);
const EMBED_TIMEOUT_MS = envMs("DASHSCOPE_EMBED_TIMEOUT_MS", 60_000);

// 超时算**瞬时失败**：抛出去让队列退避重试（见 lib/jobs.ts 的失败分档约定）。
// 所以这里要给一条能看懂的消息——AbortError 自带的那句话不说明是谁超时了。
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${label}：${timeoutMs / 1000}s 内没有完成，已中止`);
    }
    throw e;
  }
}

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
  const res = await fetchWithTimeout(
    CHAT_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        enable_thinking: false,
      }),
    },
    CHAT_TIMEOUT_MS,
    `DashScope ${model} 调用超时`,
  );
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
  // 流式不能套统一的总超时（理由见文件顶部常量处），所以自己管两个计时器：
  // 空闲计时器每收到一次数据就往后推，总上限那个只设一次。中止原因挂在
  // signal.reason 上而不是外层闭包变量——后者会让 TS 的控制流分析把它窄化成 null。
  const controller = new AbortController();
  const abortBecause = (why: string) => controller.abort(new Error(why));

  const hardTimer = setTimeout(
    () => abortBecause(`总时长超过 ${STREAM_HARD_CAP_MS / 1000}s`),
    STREAM_HARD_CAP_MS,
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortBecause(`${STREAM_IDLE_TIMEOUT_MS / 1000}s 没有收到新 token`),
      STREAM_IDLE_TIMEOUT_MS,
    );
  };

  try {
    touch();
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        enable_thinking: false,
        stream: true,
      }),
      signal: controller.signal,
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
      // 收到东西（哪怕是心跳注释行）就把空闲计时器往后推。放在 done 判断之前，
      // 这样正常收尾也会顺手续一次，不会在最后一刻被判成空闲。
      touch();
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

    // SEP_LEN > 0 是必要条件：没有分隔符时上面每段都已经即时 onToken 出去了，
    // 而 safeSent 在那条路径上从不前进（恒为 0），少了这个判断这里会把全文
    // **再发一遍**。目前两个调用方都传了 SOURCES_SEP，所以踩不到——是默认参数
    // `sep = ""` 留下的坑，写超时测试时用默认值才撞出来。
    if (SEP_LEN > 0 && !sepFound && !jsonMode && safeSent < fullText.length) {
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
  } catch (e) {
    // 把中止翻译成一句能看懂的话。超时算瞬时失败，抛出去交给队列退避重试。
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      const why = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`DashScope ${model} 流式调用已中止：${why}`);
    }
    throw e;
  } finally {
    // 两个都要清。漏掉的话，一个已经结束的请求还会留着定时器，最长 5 分钟后
    // 才对着一个早就完事的 controller 调 abort——无害但是纯浪费。
    clearTimeout(hardTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

export async function fetchEmbeddings(texts: string[], apiKey: string): Promise<{ embeddings: number[][]; usage: DashScopeUsage | null }> {
  const res = await fetchWithTimeout(
    EMBED_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimension: EMBED_DIM }),
    },
    EMBED_TIMEOUT_MS,
    `${texts.length} 段文本的 embedding 请求超时`,
  );
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
