"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AlertCircle, Download } from "lucide-react";
import Link from "next/link";
import AppHeader from "@/app/components/AppHeader";

type DocDetail = {
  id: string;
  name: string;
  size_bytes: number;
  status: string;
  last_error: string | null;
  chunk_count: number;
  content: string;
};

/**
 * 行号基准必须和切块时一致：过滤空行后从 1 开始（lib/utils.numberedLines）。
 * 这里换一种写法就会让引用整体错位，而且错得很隐蔽——跳过去看着像"差不多那一段"。
 */
function numberedLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "");
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export default function ReferenceDocPage() {
  const { id, docId } = useParams<{ id: string; docId: string }>();
  const search = useSearchParams();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  // ?lines=12-20，来自问答里的引用。缺省或写坏了就当没有，正常展示全文。
  const [hlStart, hlEnd] = useMemo(() => {
    const m = /^(\d+)-(\d+)$/.exec(search.get("lines") ?? "");
    if (!m) return [0, 0];
    const a = Number(m[1]), b = Number(m[2]);
    return a >= 1 && b >= a ? [a, b] : [0, 0];
  }, [search]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/projects/${id}/reference-docs/${docId}`);
      if (!alive) return;
      // 不判 r.ok 就 .json() 会炸在 JSON 解析上，报的错和真实原因无关
      if (!res.ok) {
        setError(res.status === 404 ? "文件不存在或无权访问" : `加载失败（${res.status}）`);
        return;
      }
      setDoc(await res.json());
    })();
    return () => { alive = false; };
  }, [id, docId]);

  // 等内容渲染完再滚。doc 变化触发，不放在 fetch 里——那时 DOM 还没有这个节点。
  useEffect(() => {
    if (doc && anchorRef.current) {
      anchorRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [doc]);

  const lines = useMemo(() => (doc ? numberedLines(doc.content) : []), [doc]);

  if (error) {
    return (
      <div className="min-h-screen bg-lark-canvas">
        <AppHeader wide back={{ href: `/projects/${id}`, label: "返回项目" }} title="参考文件" />
        <main className="max-w-3xl mx-auto px-8 py-16 text-center">
          <p className="text-sm text-lark-3">{error}</p>
        </main>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="min-h-screen bg-lark-canvas">
        <AppHeader wide back={{ href: `/projects/${id}`, label: "返回项目" }} title="参考文件" />
        <main className="max-w-3xl mx-auto px-8 py-16 text-center">
          <p className="text-sm text-lark-3">加载中...</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-lark-canvas">
      <AppHeader
        wide
        back={{ href: `/projects/${id}`, label: "返回项目" }}
        title={
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-semibold text-lark-1 truncate">{doc.name}</span>
            <span className="text-xs text-lark-3 shrink-0">
              {doc.status === "ready" ? `已入库 · ${doc.chunk_count} 段` : doc.status}
            </span>
          </span>
        }
        actions={
          <a
            href={`/api/projects/${id}/reference-docs/${docId}?download=1`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-border text-lark-2 hover:bg-lark-sunken transition-colors"
          >
            <Download size={13} />
            下载原件
          </a>
        }
      />

      <main className="max-w-3xl mx-auto px-8 py-8 space-y-4">
        {doc.status === "failed" && (
          <div className="rounded-xl border border-lark-danger/30 bg-lark-danger-light px-4 py-3 flex items-start gap-3">
            <AlertCircle size={16} className="text-lark-danger shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-lark-1">这份文件没能解析</p>
              <p className="text-xs text-lark-2 mt-0.5">{doc.last_error ?? "原因未知"}</p>
            </div>
          </div>
        )}

        {hlStart > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-lark-blue/30 bg-lark-blue-light/40 px-4 py-2.5">
            <p className="text-xs text-lark-2">
              高亮的是问答引用到的第 {hlStart}–{hlEnd} 行
            </p>
            <Link
              href={`/projects/${id}/reference-docs/${docId}`}
              className="text-xs text-lark-blue hover:underline shrink-0"
            >
              显示全文
            </Link>
          </div>
        )}

        {lines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-lark-border p-8 text-center">
            <p className="text-sm text-lark-3">
              {doc.status === "ready" ? "这份文件没有可显示的正文" : "还没有解析完"}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-lark-border bg-lark-surface shadow-card overflow-hidden">
            <div className="divide-y divide-lark-border/40">
              {lines.map((line, i) => {
                const no = i + 1;
                const hit = hlStart > 0 && no >= hlStart && no <= hlEnd;
                const heading = HEADING_RE.exec(line);
                return (
                  <div
                    key={no}
                    // 高亮区间的第一行挂 ref，进页面时滚到它
                    ref={hit && no === hlStart ? anchorRef : undefined}
                    className={`flex gap-3 px-4 py-1.5 ${hit ? "bg-lark-blue-light/60" : ""}`}
                  >
                    <span className="w-10 shrink-0 text-right text-xs text-lark-4 select-none tabular-nums pt-0.5">
                      {no}
                    </span>
                    {heading ? (
                      <span
                        className={`min-w-0 break-words text-lark-1 ${
                          heading[1].length === 1
                            ? "text-base font-semibold"
                            : heading[1].length === 2
                              ? "text-sm font-semibold"
                              : "text-sm font-medium"
                        }`}
                      >
                        {heading[2]}
                      </span>
                    ) : (
                      <span className="min-w-0 break-words text-sm text-lark-2 whitespace-pre-wrap">
                        {line}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-xs text-lark-4">
          这里显示的是从原件里抽取的纯文本，格式和排版有损失。需要原样的内容请下载原件。
        </p>
      </main>
    </div>
  );
}
