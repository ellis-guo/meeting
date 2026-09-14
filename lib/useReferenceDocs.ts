"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * 项目参考文件的状态与操作。
 *
 * 从 ReferenceDocsPanel 里抽出来的：改成三入口布局之后，「上传文件」那个入口
 * 在页面顶部，文件列表在页面底部，两处是兄弟节点。各自持有一份 docs 的话，
 * 从顶部传完文件，底部列表不会刷新——必须共享同一份状态。
 */

export type RefDoc = {
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
export const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.csv,.log";

/** 解析还没落定的状态。只要还有这类文档，就得继续轮询。 */
const PENDING = new Set(["uploaded", "parsing"]);
const POLL_MS = 2000;

export function isPending(status: string): boolean {
  return PENDING.has(status);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function useReferenceDocs(projectId: string) {
  const [docs, setDocs] = useState<RefDoc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/reference-docs`);
    // 不判 r.ok 就 .json() 会在 500 空响应体上炸在 JSON 解析里，报出来的错和
    // 真实原因毫无关系——这个项目踩过一次。
    if (!res.ok) return;
    const json = await res.json();
    setDocs(json.docs ?? []);
    setLoaded(true);
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

  const upload = useCallback(async (files: FileList | File[]): Promise<void> => {
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
  }, [projectId, load]);

  const remove = useCallback(async (doc: RefDoc): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/reference-docs/${doc.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      toast.error("删除失败");
      return;
    }
    toast.success("已删除");
    void load();
  }, [projectId, load]);

  return {
    docs,
    loaded,
    uploading,
    upload,
    remove,
    reload: load,
    /** 隐藏的 <input type="file"> 的 ref，由使用方渲染那个 input。 */
    inputRef,
    parsingCount: docs.filter((d) => PENDING.has(d.status)).length,
  };
}
