/**
 * SSE 协议的两端共用代码。
 * 服务端用 sseFrame / sseError 生成帧，客户端用 readSSE 解析。
 */

/** 回答正文与 sources JSON 之间的分隔符，由 prompt 约定，两端都要认。 */
export const SOURCES_SEP = "%%SOURCES%%";

/** 去掉流式回答里尚未闭合的 sources 段，只留正文。 */
export function stripSources(text: string): string {
  const sepIdx = text.indexOf(SOURCES_SEP);
  return sepIdx !== -1 ? text.slice(0, sepIdx).trimEnd() : text;
}

const encoder = new TextEncoder();

/** 服务端：把一个事件编码成 SSE 帧。返回类型交给 TextEncoder 推导（Response 只接受 ArrayBuffer 底层的 Uint8Array）。 */
export function sseFrame(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * 服务端：以 SSE 帧返回一个错误。
 * 客户端已经在读流，用 event: error 比 JSON 更好处理。
 */
export function sseError(
  error: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(sseFrame("error", { error }), {
    status,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

/**
 * 客户端：按 `\n\n` 分块读取 SSE 响应体，逐个事件回调。
 * 格式错误的块（含 onEvent 自身抛错）直接跳过，不中断整条流。
 */
export async function readSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = block.match(/^event: (\w+)/)?.[1];
      const dataStr = block.match(/^data: (.+)$/m)?.[1];
      if (!event || !dataStr) continue;
      try {
        onEvent(event, JSON.parse(dataStr) as Record<string, unknown>);
      } catch {
        /* skip malformed event */
      }
    }
  }
}
