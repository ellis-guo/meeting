"use client";

import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import AskInput from "./ask/AskInput";
import AskMessages from "./ask/AskMessages";
import { useAskStream } from "@/lib/useAskStream";

type AskSource = {
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  line_start: number | null;
};

export default function MeetingAskPanel({
  meetingId,
  onLineClick,
}: {
  meetingId: string;
  onLineClick?: (lineNum: number) => void;
}) {
  const ask = useAskStream<AskSource>({
    endpoint: `/api/meetings/${meetingId}/ask`,
    resetKey: meetingId,
  });

  return (
    <div className="border-t border-tm-border bg-tm-surface print:hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-2.5 border-b border-tm-border">
        <h3 className="text-xs font-medium text-tm-3">
          会议问答 {ask.messages.length > 0 && <span className="text-tm-4 normal-case ml-1">· {ask.questionCount}</span>}
        </h3>
        <div className="flex items-center gap-2">
          {ask.messages.length > 0 && (
            <button
              onClick={() => void ask.clear()}
              className="flex items-center gap-1 text-xs text-tm-3 hover:text-tm-danger transition-colors"
              title="清空对话"
            >
              <Trash2 size={12} />
              清空
            </button>
          )}
          <button
            onClick={() => ask.setCollapsed((v) => !v)}
            className="flex items-center gap-1 text-xs text-tm-3 hover:text-tm-1 transition-colors"
            title={ask.collapsed ? "展开" : "收起"}
          >
            {ask.collapsed ? (
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
      {!ask.collapsed && ask.messages.length > 0 && (
        <AskMessages
          messages={ask.messages}
          className="px-4 sm:px-6 py-4 max-h-80"
          extras={(m) =>
            m.sources && m.sources.length > 0 ? (
              <div className="mt-2 pt-2 border-t border-tm-border flex flex-wrap gap-1.5">
                {m.sources.map((s, i) => {
                  const label = s.section_title ?? s.speaker ?? "片段";
                  const canClick = s.line_start != null && !!onLineClick;
                  return (
                    <button
                      key={i}
                      onClick={canClick ? () => onLineClick!(s.line_start!) : undefined}
                      disabled={!canClick}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-tm-surface text-tm-2 border border-tm-border transition-colors ${
                        canClick ? "cursor-pointer hover:bg-tm-brand-light hover:text-tm-brand hover:border-tm-brand/30" : "cursor-default"
                      }`}
                    >
                      {label}
                      {s.line_start != null && <span className="text-tm-3">· 第 {s.line_start} 行</span>}
                    </button>
                  );
                })}
              </div>
            ) : null
          }
        />
      )}

      {/* Input bar */}
      <div className="px-4 sm:px-6 py-3">
        <AskInput
          value={ask.question}
          onChange={ask.setQuestion}
          onKeyDown={ask.handleKeyDown}
          onSend={() => void ask.ask()}
          asking={ask.asking}
          placeholder="针对本次会议提问，按 Enter 发送..."
        />
      </div>
    </div>
  );
}
