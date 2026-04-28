"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Send, Trash2 } from "lucide-react";

const SOURCES_SEP = "%%SOURCES%%";

type AskSource = {
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  line_start: number | null;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: AskSource[];
  isStreaming?: boolean;
  error?: string;
};

function renderInline(line: string): React.ReactNode {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

function renderAnswer(text: string): React.ReactNode {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    const bullet = line.match(/^\*\s+(.+)/);
    if (h2) return <p key={i} className="text-base font-semibold text-lark-1 mt-3 mb-0.5">{renderInline(h2[1])}</p>;
    if (h3) return <p key={i} className="font-medium text-lark-1 mt-2 mb-0.5">{renderInline(h3[1])}</p>;
    if (bullet) return <p key={i} className="flex gap-2 pl-2"><span className="shrink-0 text-lark-3">•</span><span>{renderInline(bullet[1])}</span></p>;
    if (line === "") return <br key={i} />;
    return <Fragment key={i}>{renderInline(line)}<br /></Fragment>;
  });
}

function stripSources(text: string): string {
  const sepIdx = text.indexOf(SOURCES_SEP);
  return sepIdx !== -1 ? text.slice(0, sepIdx).trimEnd() : text;
}

export default function MeetingAskPanel({
  meetingId,
  onLineClick,
}: {
  meetingId: string;
  onLineClick?: (lineNum: number) => void;
}) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages / streaming updates
  useEffect(() => {
    if (collapsed) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, collapsed]);

  // Reset history when switching meetings
  useEffect(() => {
    setMessages([]);
    setQuestion("");
  }, [meetingId]);

  const updateLastAssistant = (patch: Partial<Message>) => {
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
  };

  const handleAsk = async () => {
    const q = question.trim();
    if (!q || asking) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", text: q };
    const assistantMsg: Message = {
      id: `a-${Date.now()}`,
      role: "assistant",
      text: "",
      isStreaming: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setQuestion("");
    setAsking(true);
    if (collapsed) setCollapsed(false);

    try {
      const res = await fetch(`/api/meetings/${meetingId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });

      if (!res.body) {
        updateLastAssistant({ isStreaming: false, error: "请求失败" });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";

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
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            if (event === "token") {
              acc += (data.text as string) ?? "";
              updateLastAssistant({ text: stripSources(acc) });
            } else if (event === "done") {
              const sources = Array.isArray(data.sources) ? (data.sources as AskSource[]) : [];
              updateLastAssistant({ sources, isStreaming: false });
            } else if (event === "error") {
              updateLastAssistant({
                isStreaming: false,
                error: (data.error as string) ?? "请求失败",
              });
            }
          } catch {
            /* skip malformed */
          }
        }
      }
      // Stream ended without explicit done (defensive)
      updateLastAssistant({ isStreaming: false });
    } catch {
      updateLastAssistant({ isStreaming: false, error: "网络错误，请重试" });
    } finally {
      setAsking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  const handleClear = () => {
    if (messages.length === 0) return;
    if (!window.confirm("清空当前会话历史？")) return;
    setMessages([]);
  };

  return (
    <div className="border-t border-lark-border bg-lark-surface print:hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-2.5 border-b border-lark-border">
        <h3 className="text-xs font-semibold text-lark-3 uppercase tracking-wider">
          会议问答 {messages.length > 0 && <span className="text-lark-4 normal-case ml-1">· {messages.filter((m) => m.role === "user").length}</span>}
        </h3>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              onClick={handleClear}
              className="flex items-center gap-1 text-xs text-lark-3 hover:text-lark-danger transition-colors"
              title="清空对话"
            >
              <Trash2 size={12} />
              清空
            </button>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-1 text-xs text-lark-3 hover:text-lark-1 transition-colors"
            title={collapsed ? "展开" : "收起"}
          >
            {collapsed ? (
              <>
                <ChevronUp size={13} />
                展开
              </>
            ) : (
              <>
                <ChevronDown size={13} />
                收起
              </>
            )}
          </button>
        </div>
      </div>

      {/* Messages list */}
      {!collapsed && messages.length > 0 && (
        <div className="px-6 py-4 max-h-80 overflow-y-auto space-y-3">
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                  m.role === "user"
                    ? "bg-lark-blue text-white rounded-br-sm"
                    : m.error
                      ? "bg-lark-danger/5 border border-lark-danger/30 text-lark-danger rounded-bl-sm"
                      : "bg-lark-sunken text-lark-1 rounded-bl-sm"
                }`}
              >
                {m.role === "user" ? (
                  <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                ) : m.error ? (
                  <p className="leading-relaxed">{m.error}</p>
                ) : (
                  <>
                    <div className="leading-relaxed">
                      {m.text ? renderAnswer(m.text) : <span className="text-lark-3">思考中...</span>}
                    </div>
                    {m.sources && m.sources.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-lark-border flex flex-wrap gap-1.5">
                        {m.sources.map((s, i) => {
                          const label = s.section_title ?? s.speaker ?? "片段";
                          const canClick = s.line_start != null && !!onLineClick;
                          return (
                            <button
                              key={i}
                              onClick={canClick ? () => onLineClick!(s.line_start!) : undefined}
                              disabled={!canClick}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-lark-surface text-lark-2 border border-lark-border transition-colors ${
                                canClick ? "cursor-pointer hover:bg-lark-blue-light hover:text-lark-blue hover:border-lark-blue/30" : "cursor-default"
                              }`}
                            >
                              {label}
                              {s.line_start != null && <span className="text-lark-3">· 第 {s.line_start} 行</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input bar */}
      <div className="px-6 py-3 flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="针对本次会议提问，按 Enter 发送..."
          rows={1}
          className="flex-1 resize-none rounded-lg border border-lark-border bg-lark-sunken px-3 py-2 text-sm text-lark-1 placeholder:text-lark-4 focus:outline-none focus:ring-1 focus:ring-lark-blue/40 transition-colors"
        />
        <button
          onClick={handleAsk}
          disabled={asking || !question.trim()}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          <Send size={13} />
          {asking ? "思考中..." : "提问"}
        </button>
      </div>
    </div>
  );
}
