"use client";

import { useEffect, useRef } from "react";
import AskMarkdown, { CitationResolver } from "./AskMarkdown";
import { AskMessage } from "@/lib/useAskStream";

interface Props<S> {
  messages: AskMessage<S>[];
  /** 容器内边距与最大高度按面板布局给。 */
  className?: string;
  /** 回答里的 [日期 · 章节] 引用怎么解析成链接。 */
  resolve?: (m: AskMessage<S>) => CitationResolver | undefined;
  /** 回答气泡底部的附加内容（来源标签 / 下载 debug）。 */
  extras?: (m: AskMessage<S>, prevUserText: string) => React.ReactNode;
}

/** 问答气泡列表，随消息更新自动滚到底部。 */
export default function AskMessages<S>({ messages, className = "", resolve, extras }: Props<S>) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className={`overflow-y-auto space-y-3 ${className}`}>
      {messages.map((m, idx) => {
        const prevUser = idx > 0 && messages[idx - 1].role === "user" ? messages[idx - 1].text : "";
        return (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                m.role === "user"
                  ? "bg-tm-brand text-white rounded-br-sm"
                  : m.error
                    ? "bg-tm-danger/5 border border-tm-danger/30 text-tm-danger rounded-bl-sm"
                    : "bg-tm-sunken text-tm-1 rounded-bl-sm"
              }`}
            >
              {m.role === "user" ? (
                <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
              ) : m.error ? (
                <p className="leading-relaxed">{m.error}</p>
              ) : (
                <>
                  <div className="leading-relaxed">
                    {m.text ? (
                      <AskMarkdown text={m.text} resolve={resolve?.(m)} />
                    ) : (
                      <span className="text-tm-3">思考中...</span>
                    )}
                  </div>
                  {extras?.(m, prevUser)}
                </>
              )}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
