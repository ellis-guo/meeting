"use client";

import { ChevronDown, ChevronUp, Download, Trash2 } from "lucide-react";
import AskInput from "./ask/AskInput";
import AskMessages from "./ask/AskMessages";
import { AskMessage, useAskStream } from "@/lib/useAskStream";

type AskSource = {
  meeting_id: string | null;
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  meeting_date: string | null;
};

function downloadDebug(msg: AskMessage<AskSource>, userText: string) {
  if (!msg.debug) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const q = userText.trim().slice(0, 10).replace(/[\/:*?"<>|]/g, "_");
  const blob = new Blob([JSON.stringify(msg.debug, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `debug_${ts}_${q}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ProjectAskPanel({
  projectId,
  blocked,
  blockedCount,
}: {
  projectId: string;
  blocked: boolean;
  blockedCount: number;
}) {
  const ask = useAskStream<AskSource>({
    endpoint: `/api/projects/${projectId}/ask`,
    resetKey: projectId,
    blocked,
  });

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-lark-3 uppercase tracking-wider">项目问答</h2>
        {ask.messages.length > 0 && (
          <button
            onClick={() => ask.setCollapsed((v) => !v)}
            className="flex items-center gap-1 text-xs text-lark-3 hover:text-lark-1 transition-colors"
            title={ask.collapsed ? "展开历史" : "收起历史"}
          >
            {ask.collapsed ? (
              <>
                <ChevronUp size={12} />
                展开历史 ({ask.questionCount})
              </>
            ) : (
              <>
                <ChevronDown size={12} />
                收起历史
              </>
            )}
          </button>
        )}
      </div>
      <div className="rounded-xl border border-lark-border bg-lark-surface shadow-card overflow-hidden">
        {blocked && (
          <div className="m-4 rounded-lg bg-lark-blue-light/40 border border-lark-blue/20 px-3 py-2 text-xs text-lark-2">
            需要先处理 {blockedCount} 条主文档更新建议后才能提问。
          </div>
        )}

        {ask.messages.length > 0 && !ask.collapsed && (
          <AskMessages
            messages={ask.messages}
            className="px-4 py-4 max-h-[36rem] border-b border-lark-border"
            resolve={(m) => (date, section) => {
              // 优先精确匹配 date + section_title；回退到仅 date 匹配
              const exact = m.sources?.find(
                (src) => src.meeting_date === date && src.section_title?.trim() === section && src.meeting_id,
              );
              const fallback = m.sources?.find((src) => src.meeting_date === date && src.meeting_id);
              const s = exact ?? fallback;
              return s?.meeting_id ? `/projects/${projectId}/meetings/${s.meeting_id}` : null;
            }}
            extras={(m, prevUser) =>
              !m.isStreaming && m.debug ? (
                <div className="mt-2 pt-2 border-t border-lark-border flex justify-end">
                  <button
                    onClick={() => downloadDebug(m, prevUser)}
                    className="flex items-center gap-1 text-[11px] text-lark-3 hover:text-lark-2 transition-colors"
                  >
                    <Download size={11} />
                    下载 Debug
                  </button>
                </div>
              ) : null
            }
          />
        )}

        <div className="p-4 space-y-2">
          <AskInput
            value={ask.question}
            onChange={ask.setQuestion}
            onKeyDown={ask.handleKeyDown}
            onSend={() => void ask.ask()}
            asking={ask.asking}
            disabled={blocked}
            placeholder={blocked ? "请先处理待确认的主文档更新..." : "针对整个项目历史提问，按 Enter 发送..."}
          />
          {ask.messages.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={() => void ask.clear()}
                className="flex items-center gap-1 text-xs text-lark-3 hover:text-lark-danger transition-colors"
              >
                <Trash2 size={11} />
                清空对话
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
