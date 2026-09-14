"use client";

import { ChevronDown, ChevronUp, Download, Trash2 } from "lucide-react";
import AskInput from "./ask/AskInput";
import AskMessages from "./ask/AskMessages";
import { AskMessage, useAskStream } from "@/lib/useAskStream";

type AskSource = {
  meeting_id: string | null;
  reference_doc_id: string | null;
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  meeting_date: string | null;
  /** 只有参考文件有：这次实际取回的行区间，用来在查看页里定位并高亮。 */
  line_start: number | null;
  line_end: number | null;
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

export default function ProjectAskPanel({ projectId }: { projectId: string }) {
  const ask = useAskStream<AskSource>({
    endpoint: `/api/projects/${projectId}/ask`,
    resetKey: projectId,
  });

  return (
    // 区块头放进卡片里，和「会议」「文件」两块保持同一种结构——
    // 三块并排时标题在卡内还是卡外这点不一致，比配色不一致还显眼。
    <section className="rounded-lg border border-tm-border bg-tm-surface overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 h-12 border-b border-tm-border-light">
        <h2 className="text-sm font-medium text-tm-1">项目问答</h2>
        {ask.messages.length > 0 && (
          <button
            onClick={() => ask.setCollapsed((v) => !v)}
            className="flex items-center gap-1 text-xs text-tm-3 hover:text-tm-1 transition-colors"
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
      <>
        {ask.messages.length > 0 && !ask.collapsed && (
          <AskMessages
            messages={ask.messages}
            className="px-4 py-4 max-h-[36rem] border-b border-tm-border"
            resolve={(m) => (head, section) => {
              // 参考文件：`[参考文件 · 文件名 › 章节]`，没有日期，靠标题对上来源
              if (head === "参考文件") {
                const exact = m.sources?.find(
                  (src) => src.chunk_type === "reference"
                    && src.section_title?.trim() === section
                    && src.reference_doc_id,
                );
                // 标题对不上时退到"同一份文件"——文件名是标题的第一段，模型很难写错；
                // 但这时**不带行号**，宁可停在文档开头也不要跳到错误的位置。
                const byFile = m.sources?.find((src) => {
                  if (src.chunk_type !== "reference" || !src.reference_doc_id) return false;
                  // 文件名是 section_title 的第一段。取不到或为空时**不能**退成 ""：
                  // startsWith("") 恒为 true，会把答案里的章节匹配到任意一份文件上。
                  //（这里原先是一个字面的 NUL 字节当哨兵，语义对但让 git 把整个
                  //  文件当成二进制——没有 diff、没有 blame、grep 也跳过它。）
                  const fileName = src.section_title?.split(" › ")[0];
                  return !!fileName && section.startsWith(fileName);
                });
                const s = exact ?? byFile;
                if (!s?.reference_doc_id) return null;
                const base = `/projects/${projectId}/reference-docs/${s.reference_doc_id}`;
                return s === exact && s.line_start && s.line_end
                  ? `${base}?lines=${s.line_start}-${s.line_end}`
                  : base;
              }
              // 会议：优先精确匹配 date + section_title；回退到仅 date 匹配
              const exact = m.sources?.find(
                (src) => src.meeting_date === head && src.section_title?.trim() === section && src.meeting_id,
              );
              const fallback = m.sources?.find((src) => src.meeting_date === head && src.meeting_id);
              const s = exact ?? fallback;
              return s?.meeting_id ? `/projects/${projectId}/meetings/${s.meeting_id}` : null;
            }}
            extras={(m, prevUser) =>
              !m.isStreaming && m.debug ? (
                <div className="mt-2 pt-2 border-t border-tm-border flex justify-end">
                  <button
                    onClick={() => downloadDebug(m, prevUser)}
                    className="flex items-center gap-1 text-[11px] text-tm-3 hover:text-tm-2 transition-colors"
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
            placeholder="针对整个项目历史提问，按 Enter 发送..."
          />
          {ask.messages.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={() => void ask.clear()}
                className="flex items-center gap-1 text-xs text-tm-3 hover:text-tm-danger transition-colors"
              >
                <Trash2 size={11} />
                清空对话
              </button>
            </div>
          )}
        </div>
      </>
    </section>
  );
}
