"use client";

import Link from "next/link";
import { AlertCircle, Download, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { useConfirm } from "@/lib/ConfirmContext";
import { RefDoc, formatSize, isPending } from "@/lib/useReferenceDocs";

/**
 * 项目的「文件」区块（PRD 4.3：文件独立一块区域）。
 *
 * 只负责展示和删除——上传状态、轮询、上传动作全在 useReferenceDocs 里，
 * 因为顶部的「上传文件」入口要用同一份。这个组件以前是自带拖拽区的折叠面板，
 * 拆开之后它就是一张列表。
 */

function StatusTag({ doc }: { doc: RefDoc }) {
  if (doc.status === "ready") {
    return (
      <span className="text-xs text-tm-3 shrink-0 tabular-nums">
        已入库 · {doc.chunk_count} 段
      </span>
    );
  }
  if (doc.status === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-tm-danger shrink-0">
        <AlertCircle size={11} />
        解析失败
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-tm-brand shrink-0">
      <Loader2 size={11} className="animate-spin" />
      {doc.status === "parsing" ? "解析中" : "排队中"}
    </span>
  );
}

export default function ReferenceDocsPanel({
  projectId,
  docs,
  loaded,
  parsingCount,
  onRemove,
  onPickFile,
}: {
  projectId: string;
  docs: RefDoc[];
  loaded: boolean;
  parsingCount: number;
  onRemove: (doc: RefDoc) => void;
  onPickFile: () => void;
}) {
  const confirm = useConfirm();

  const remove = async (doc: RefDoc) => {
    const ok = await confirm({
      title: `删除「${doc.name}」？`,
      description: "原件和它在检索库里的全部片段都会被删除，无法恢复。",
      confirmLabel: "删除",
      danger: true,
    });
    if (ok) onRemove(doc);
  };

  return (
    <section className="rounded-lg border border-tm-border bg-tm-surface overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 h-12 border-b border-tm-border-light">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-medium text-tm-1 shrink-0">文件</h2>
          {loaded && docs.length > 0 && (
            <span className="text-xs text-tm-3 tabular-nums shrink-0">{docs.length}</span>
          )}
          {parsingCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-tm-brand shrink-0">
              <Loader2 size={11} className="animate-spin" />
              {parsingCount} 份解析中
            </span>
          )}
        </div>
        <button
          onClick={onPickFile}
          className="flex items-center gap-1 text-xs text-tm-2 hover:text-tm-brand transition-colors shrink-0"
        >
          <Plus size={13} />
          上传
        </button>
      </div>

      {loaded && docs.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-tm-3">
          还没有文件。需求文档、规范、纪要原件都可以传，解析后能被问答直接引用到章节。
        </p>
      )}

      <ul className="divide-y divide-tm-border-light">
        {docs.map((doc) => {
          // 只有解析完成的才点得进查看页——还在解析的进去是空的，失败的更是。
          const viewable = doc.status === "ready";
          const inner = (
            <>
              <FileText size={15} className="text-tm-3 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-tm-1 truncate">{doc.name}</p>
                <p className="text-xs text-tm-3 mt-0.5 truncate">
                  {formatSize(doc.size_bytes)}
                  {doc.status === "failed" && doc.last_error ? ` · ${doc.last_error}` : ""}
                </p>
              </div>
              <StatusTag doc={doc} />
            </>
          );

          return (
            <li key={doc.id} className="flex items-center gap-3 px-4 py-3 hover:bg-tm-sunken transition-colors">
              {viewable ? (
                <Link
                  href={`/projects/${projectId}/reference-docs/${doc.id}`}
                  className="flex items-center gap-3 flex-1 min-w-0"
                >
                  {inner}
                </Link>
              ) : (
                <div className="flex items-center gap-3 flex-1 min-w-0">{inner}</div>
              )}
              <a
                href={`/api/projects/${projectId}/reference-docs/${doc.id}?download=1`}
                className="p-1.5 rounded text-tm-3 hover:text-tm-2 hover:bg-tm-hover transition-colors shrink-0"
                title="下载原件"
              >
                <Download size={13} />
              </a>
              <button
                onClick={() => remove(doc)}
                className="p-1.5 rounded text-tm-3 hover:text-tm-danger hover:bg-tm-danger-light transition-colors shrink-0"
                title="删除"
              >
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>

      {isPendingAny(docs) && (
        // ⚠️ 这里不能写「完成后铃铛会提示」：parseHandler 不建 Notification
        // （只有 summarizeHandler 建）。文件解析目前是静默完成的，用户只能
        // 靠这个列表自己轮询看到结果。
        <p className="px-4 py-2 text-xs text-tm-4 border-t border-tm-border-light">
          解析在后台进行，这一栏会自动刷新。关掉页面也不影响解析。
        </p>
      )}
    </section>
  );
}

function isPendingAny(docs: RefDoc[]): boolean {
  return docs.some((d) => isPending(d.status));
}
