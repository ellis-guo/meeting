"use client";

import { Fragment, useRef, useState } from "react";
import { Send } from "lucide-react";

const SOURCES_SEP = "%%SOURCES%%";

type AskSource = {
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  line_start: number | null;
};

function renderInline(line: string): React.ReactNode {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) => i % 2 === 1 ? <strong key={i}>{part}</strong> : part);
}

function renderAnswer(text: string): React.ReactNode {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    const bullet = line.match(/^\*\s+(.+)/);
    if (h2) return <p key={i} className="text-base font-semibold text-lark-1 mt-4 mb-0.5">{renderInline(h2[1])}</p>;
    if (h3) return <p key={i} className="font-medium text-lark-1 mt-3 mb-0.5">{renderInline(h3[1])}</p>;
    if (bullet) return <p key={i} className="flex gap-2 pl-2"><span className="shrink-0 text-lark-3">•</span><span>{renderInline(bullet[1])}</span></p>;
    if (line === "") return <br key={i} />;
    return <Fragment key={i}>{renderInline(line)}<br /></Fragment>;
  });
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
  const [rawText, setRawText] = useState<string | null>(null);
  const [sources, setSources] = useState<AskSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleAsk = async () => {
    if (!question.trim() || asking) return;
    setAsking(true);
    setRawText(null);
    setSources([]);
    setError(null);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      if (!res.body) {
        setError("请求失败");
        return;
      }

      const reader = res.body.getReader();
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
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            if (event === "token") {
              setRawText((prev) => (prev ?? "") + ((data.text as string) ?? ""));
            } else if (event === "done") {
              setSources(Array.isArray(data.sources) ? (data.sources as AskSource[]) : []);
            } else if (event === "error") {
              setError((data.error as string) ?? "请求失败");
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      setError("网络错误，请重试");
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

  const displayText = rawText !== null
    ? (() => {
        const sepIdx = rawText.indexOf(SOURCES_SEP);
        return sepIdx !== -1 ? rawText.slice(0, sepIdx).trimEnd() : rawText;
      })()
    : null;

  return (
    <div className="border-t border-lark-border px-6 py-5 bg-lark-surface print:hidden">
      <h3 className="text-xs font-semibold text-lark-3 uppercase tracking-wider mb-3">会议问答</h3>
      <div className="space-y-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="针对本次会议提问，按 Enter 发送..."
            rows={2}
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

        {error && (
          <p className="text-sm text-lark-danger">{error}</p>
        )}

        {displayText !== null && (
          <div className="space-y-3 pt-1 border-t border-lark-border">
            <div className="text-sm text-lark-1 leading-relaxed">
              {renderAnswer(displayText)}
              {asking && (
                <span className="inline-block w-0.5 h-3.5 ml-0.5 bg-lark-blue animate-pulse align-middle" />
              )}
            </div>
            {sources.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-lark-3 uppercase tracking-wider">来源</p>
                <div className="flex flex-wrap gap-2">
                  {sources.map((s, i) => {
                    const label = s.section_title ?? s.speaker ?? "片段";
                    const canClick = s.line_start != null && !!onLineClick;
                    return (
                      <button
                        key={i}
                        onClick={canClick ? () => { onLineClick!(s.line_start!); } : undefined}
                        disabled={!canClick}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-lark-sunken text-lark-2 transition-colors ${
                          canClick
                            ? "cursor-pointer hover:bg-lark-blue-light hover:text-lark-blue"
                            : "cursor-default"
                        }`}
                      >
                        {label}
                        {s.line_start != null && (
                          <span className="text-lark-3">· 第 {s.line_start} 行</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
