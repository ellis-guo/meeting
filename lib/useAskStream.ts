"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { readSSE, stripSources } from "@/lib/sse";
import { useConfirm } from "@/lib/ConfirmContext";

export type AskMessage<S> = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: S[];
  debug?: object;
  isStreaming?: boolean;
  error?: string;
};

/**
 * 会议问答与项目问答共用的流式对话逻辑。
 * 两边只有布局和引用渲染不同，请求 / SSE 解析 / 消息状态完全一致。
 */
export function useAskStream<S>({
  endpoint,
  resetKey,
  blocked = false,
}: {
  endpoint: string;
  /** 变化时清空历史（切换会议 / 项目）。 */
  resetKey: string;
  /** 为 true 时禁止提问。 */
  blocked?: boolean;
}) {
  const confirmDialog = useConfirm();
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<AskMessage<S>[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setMessages([]);
    setQuestion("");
  }, [resetKey]);

  const updateLastAssistant = useCallback((patch: Partial<AskMessage<S>>) => {
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant") {
          copy[i] = { ...copy[i], ...patch };
          break;
        }
      }
      return copy;
    });
  }, []);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking || blocked) return;

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", text: q },
      { id: `a-${Date.now()}`, role: "assistant", text: "", isStreaming: true },
    ]);
    setQuestion("");
    setAsking(true);
    setCollapsed(false);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });

      // 前置校验失败时，项目问答返回 JSON、会议问答返回 SSE error 帧，两种都要认。
      const isStream = (res.headers.get("Content-Type") ?? "").includes("text/event-stream");
      if (!res.ok && !isStream) {
        let msg = `请求失败 (${res.status})`;
        try {
          const data = await res.json();
          msg = data.error ?? msg;
        } catch { /* keep default */ }
        updateLastAssistant({ isStreaming: false, error: msg });
        return;
      }

      if (!res.body) {
        updateLastAssistant({ isStreaming: false, error: "请求失败" });
        return;
      }

      let acc = "";
      await readSSE(res.body, (event, data) => {
        if (event === "token") {
          acc += (data.text as string) ?? "";
          updateLastAssistant({ text: stripSources(acc) });
        } else if (event === "done") {
          updateLastAssistant({
            sources: Array.isArray(data.sources) ? (data.sources as S[]) : [],
            debug: data._debug !== undefined ? (data._debug as object) : undefined,
            isStreaming: false,
          });
        } else if (event === "error") {
          updateLastAssistant({
            isStreaming: false,
            error: (data.error as string) ?? "请求失败",
          });
        }
      });
      // 流结束但没收到 done（兜底）
      updateLastAssistant({ isStreaming: false });
    } catch {
      updateLastAssistant({ isStreaming: false, error: "网络错误，请重试" });
    } finally {
      setAsking(false);
    }
  }, [asking, blocked, endpoint, question, updateLastAssistant]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void ask();
      }
    },
    [ask],
  );

  const clear = useCallback(async () => {
    if (messages.length === 0) return;
    const ok = await confirmDialog({
      title: "清空当前会话历史？",
      confirmLabel: "清空",
      danger: true,
    });
    if (ok) setMessages([]);
  }, [confirmDialog, messages.length]);

  return {
    question,
    setQuestion,
    asking,
    messages,
    collapsed,
    setCollapsed,
    ask,
    clear,
    handleKeyDown,
    questionCount: messages.filter((m) => m.role === "user").length,
  };
}
