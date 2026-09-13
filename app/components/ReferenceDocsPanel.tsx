"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle, ChevronRight, Download, FileText, Loader2, Trash2, Upload,
} from "lucide-react";
import { useConfirm } from "@/lib/ConfirmContext";

type RefDoc = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  status: string; // uploaded / parsing / ready / failed
  last_error: string | null;
  chunk_count: number;
  created_at: string;
};

/** 和后端 documentParser.detectKind 认的扩展名保持一致。 */
const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.csv,.log";

/** 解析还没落定的状态。只要还有这类文档，就得继续轮询。 */
const PENDING = new Set(["uploaded", "parsing"]);
const POLL_MS = 2000;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StatusTag({ doc }: { doc: RefDoc }) {
  if (doc.status === "ready") {
    return (
      <span className="text-xs text-lark-3 shrink-0">
        已入库 · {doc.chunk_count} 段
      </span>
    );
  }
  if (doc.status === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-lark-danger shrink-0">
        <AlertCircle size={11} />
        解析失败
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-lark-blue shrink-0">
      <Loader2 size={11} className="animate-spin" />
      {doc.status === "parsing" ? "解析中" : "排队中"}
    </span>
  );
}

export default function ReferenceDocsPanel({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<RefDoc[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const load = useCallback(async (): Promise<RefDoc[]> => {
    const res = await fetch(`/api/projects/${projectId}/reference-docs`);
    // 不判 r.ok 就 .json() 会在 500 空响应体上炸在 JSON 解析里，报出来的错和
    // 真实原因毫无关系——这个项目踩过一次。
    if (!res.ok) return [];
    const json = await res.json();
    const next: RefDoc[] = json.docs ?? [];
    setDocs(next);
    setLoaded(true);
    return next;
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // 解析是后台任务，页面得自己等结果。
  //
  // 轮询由 docs 自己驱动而不是手写递归定时器：每次 load 更新 docs → 这个 effect
  // 重跑 → 还有未落定的就再排一次。全部落定时它什么都不排，自然停住；上传之后
  // 也不需要另外把轮询"拉起来"，load() 带来的新 docs 会让它自己续上。
  useEffect(() => {
    if (!docs.some((d) => PENDING.has(d.status))) return;
    const t = setTimeout(() => { void load(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [docs, load]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of list) fd.append("files", f);
      const res = await fetch(`/api/projects/${projectId}/reference-docs`, {
        method: "POST",
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 后端的报错是写给人看的（"「x.doc」是旧版 .doc，请另存为 .docx"），
        // 直接透出去，别换成笼统的"上传失败"
        toast.error(json.error ?? `上传失败（${res.status}）`);
        return;
      }
      toast.success(`已上传 ${json.docs?.length ?? list.length} 份，正在后台解析`);
      await load();
    } catch (e) {
      toast.error(`上传失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (doc: RefDoc) => {
    const ok = await confirm({
      title: `删除「${doc.name}」？`,
      description: "原件和它在检索库里的全部片段都会被删除，无法恢复。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/projects/${projectId}/reference-docs/${doc.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      toast.error("删除失败");
      return;
    }
    toast.success("已删除");
    void load();
  };

  const parsing = docs.filter((d) => PENDING.has(d.status)).length;

  return (
    <div className="rounded-xl border border-lark-border bg-lark-surface shadow-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-lark-sunken transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-lark-1 shrink-0">参考文件</span>
          {loaded && docs.length > 0 && (
            <span className="text-xs text-lark-3 shrink-0">{docs.length}</span>
          )}
          {parsing > 0 && (
            <span className="flex items-center gap-1 text-xs text-lark-blue shrink-0">
              <Loader2 size={11} className="animate-spin" />
              {parsing} 份解析中
            </span>
          )}
        </div>
        <ChevronRight
          size={15}
          className={`text-lark-3 transition-transform duration-200 shrink-0 ml-2 ${expanded ? "rotate-90" : ""}`}
        />
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-3">
          <p className="text-xs text-lark-3">
            需求文档、规范、纪要原件都可以传。解析后会和会议记录一样进检索，问答能直接引用到具体章节。
          </p>

          {docs.length > 0 && (
            <ul className="space-y-1.5">
              {docs.map((doc) => (
                <li
                  key={doc.id}
                  className="flex items-center gap-3 rounded-lg border border-lark-border px-3 py-2"
                >
                  <FileText size={14} className="text-lark-3 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-lark-1 truncate">{doc.name}</p>
                    <p className="text-xs text-lark-3 mt-0.5">
                      {formatSize(doc.size_bytes)}
                      {doc.status === "failed" && doc.last_error ? ` · ${doc.last_error}` : ""}
                    </p>
                  </div>
                  <StatusTag doc={doc} />
                  <a
                    href={`/api/projects/${projectId}/reference-docs/${doc.id}?download=1`}
                    className="p-1.5 rounded text-lark-3 hover:text-lark-2 hover:bg-lark-sunken transition-colors shrink-0"
                    title="下载原件"
                  >
                    <Download size={13} />
                  </a>
                  <button
                    onClick={() => remove(doc)}
                    className="p-1.5 rounded text-lark-3 hover:text-lark-danger hover:bg-lark-danger/5 transition-colors shrink-0"
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            className={`rounded-lg border border-dashed px-4 py-5 text-center cursor-pointer transition-colors ${
              dragging
                ? "border-lark-blue bg-lark-blue-light/40"
                : "border-lark-border hover:border-lark-blue/40 hover:bg-lark-sunken"
            }`}
          >
            {uploading ? (
              <span className="flex items-center justify-center gap-2 text-sm text-lark-2">
                <Loader2 size={14} className="animate-spin" />
                上传中...
              </span>
            ) : (
              <>
                <span className="flex items-center justify-center gap-2 text-sm text-lark-2">
                  <Upload size={14} />
                  拖文件到这里，或点击选择
                </span>
                <p className="text-xs text-lark-4 mt-1">
                  PDF / Word(.docx) / 纯文本，单份不超过 10MB
                </p>
              </>
            )}
          </div>

          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => { if (e.target.files) void upload(e.target.files); }}
          />
        </div>
      )}
    </div>
  );
}
