"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { Modality, Project } from "@/app/types";
import AppShell from "@/app/components/AppShell";
import AppHeader from "@/app/components/AppHeader";
import ProjectAskPanel from "@/app/components/ProjectAskPanel";
import ReferenceDocsPanel from "@/app/components/ReferenceDocsPanel";
import SourceEntries from "@/app/components/SourceEntries";
import ModalityTag from "@/app/components/ModalityTag";
import { useConfirm } from "@/lib/ConfirmContext";
import { ACCEPT, useReferenceDocs } from "@/lib/useReferenceDocs";
import { patchName, removeLocal, refresh as refreshProjects } from "@/lib/projectsStore";

type MeetingCardData = {
  id: string;
  created_at: string;
  summary: {
    meta: {
      date: string | null;
      participants: string[];
      title?: string | null;
      modality?: Modality | null;
    };
  };
  processing_status?: string;
};

function StatusBadge({ meeting }: { meeting: MeetingCardData }) {
  const status = meeting.processing_status;

  if (status === "processing" || status === "pending") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-tm-brand-light text-tm-brand font-medium shrink-0">
        处理中
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-tm-danger-light text-tm-danger font-medium shrink-0">
        生成失败
      </span>
    );
  }
  return null;
}

/**
 * 会议的一行：日期 + AI 生成的标题 + 线上/线下 tag（PRD 4.3）。
 *
 * ⚠️ 标题和 tag 都可能没有——2026-09-14 之前的存量会议没这两个字段，模型也
 * 可能按 prompt 要求填了 null。**没有就不占位**：标题缺席时参会人顶上来当主
 * 信息（也就是改之前的样子），而不是渲染一个"未命名会议"。占位文案会让用户
 * 以为那是模型给的结论。
 */
function MeetingRow({ meeting, projectId }: { meeting: MeetingCardData; projectId: string }) {
  const { meta } = meeting.summary;
  const date = meta.date ?? new Date(meeting.created_at).toLocaleDateString("zh-CN");
  const participants = meta.participants.length > 0 ? meta.participants.join("、") : "—";
  const title = meta.title?.trim() || null;

  return (
    <li>
      <Link
        href={`/projects/${projectId}/meetings/${meeting.id}`}
        aria-label={title ? `${date}「${title}」` : `${date} 的会议记录`}
        className="flex items-center gap-3 px-4 py-3 hover:bg-tm-sunken transition-colors"
      >
        <span className="text-sm text-tm-2 tabular-nums shrink-0 w-24">{date}</span>
        <StatusBadge meeting={meeting} />
        {title ? (
          <span className="flex items-baseline gap-2 flex-1 min-w-0">
            <span className="text-sm font-medium text-tm-1 truncate">{title}</span>
            {/* 有标题时参会人退成次要信息，窄屏上直接让位 */}
            <span className="hidden sm:block text-xs text-tm-3 truncate">{participants}</span>
          </span>
        ) : (
          <span className="text-sm text-tm-3 truncate flex-1 min-w-0">{participants}</span>
        )}
        <ModalityTag modality={meta.modality} />
        <ChevronRight size={15} className="text-tm-4 shrink-0" />
      </Link>
    </li>
  );
}

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const confirm = useConfirm();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const refDocs = useReferenceDocs(id);

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  const handleStartRename = () => {
    if (!project) return;
    setNameDraft(project.name);
    setEditingName(true);
  };

  const handleSaveName = async () => {
    if (!project) return;
    const newName = nameDraft.trim();
    if (!newName || newName === project.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "重命名失败");
      setProject((p) => (p ? { ...p, name: newName } : p));
      // 侧边栏读的是共享 store，不同步的话它会一直挂着旧名字直到下次整页刷新
      patchName(id, newName);
      setEditingName(false);
      toast.success("项目已重命名");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSavingName(false);
    }
  };

  const handleReembed = async () => {
    setReembedding(true);
    try {
      const res = await fetch(`/api/projects/${id}/reembed`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message ?? "向量索引重建完成");
      } else {
        toast.error(data.error ?? "向量化失败，请重试");
      }
    } catch {
      toast.error("网络错误，请重试");
    } finally {
      setReembedding(false);
    }
  };

  const handleDeleteProject = async () => {
    const ok = await confirm({
      title: `确认删除项目「${project?.name}」？`,
      description: "项目下所有会议记录和文件也将一并删除，此操作不可撤销。",
      confirmLabel: "删除项目",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      removeLocal(id);
      toast.success("项目已删除");
      router.push("/");
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => {
        // 只判 404 的话，5xx 会把 { error } 当成 project 塞进 state，页面直接白屏。
        if (!r.ok) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => {
        if (data && typeof data === "object" && data.id) setProject(data);
        else if (data) setNotFound(true);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  // 直接用 URL 进到一个新项目时，侧边栏的列表可能还没有它。
  useEffect(() => { void refreshProjects(); }, [id]);

  if (loading) {
    return (
      <AppShell>
        <div className="h-[60vh] flex items-center justify-center">
          <p className="text-sm text-tm-3">加载中...</p>
        </div>
      </AppShell>
    );
  }

  if (notFound || !project) {
    return (
      <AppShell>
        <div className="h-[60vh] flex items-center justify-center flex-col gap-4">
          <p className="text-sm text-tm-2">项目不存在</p>
          <Link href="/" className="text-sm text-tm-brand hover:underline">返回工作台</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <AppHeader
        wide
        crumbs={[{ label: "项目" }]}
        title={
          editingName ? (
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleSaveName(); }
                else if (e.key === "Escape") { e.preventDefault(); setEditingName(false); }
              }}
              onBlur={() => setEditingName(false)}
              autoFocus
              disabled={savingName}
              maxLength={100}
              className="text-sm font-semibold text-tm-1 bg-tm-surface border border-tm-brand rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-tm-brand-focus w-full min-w-0 sm:w-auto sm:min-w-[160px]"
              // 内联 ref 每次渲染身份都变，React 会重新挂载 ref；如果在这里调 select()，
              // 每敲一个字都会全选一次，下一个字直接把前面覆盖掉。改成挂载时选一次。
              ref={nameInputRef}
            />
          ) : (
            // truncate 少不了：项目名可以到 100 字，不截断的话它会在窄屏上换行撑高
            // 顶栏，并且和左边的面包屑叠在一起——手机上实测就是这个样子。
            <span
              className="block truncate text-sm font-semibold text-tm-1 cursor-pointer hover:bg-tm-hover rounded-md px-1.5 py-1 transition-colors"
              onDoubleClick={handleStartRename}
              title={`${project.name}（双击重命名）`}
            >
              {project.name}
            </span>
          )
        }
        actions={
          <>
            <button
              onClick={handleReembed}
              title="重新向量化"
              disabled={reembedding}
              className="flex items-center gap-1.5 px-2 sm:px-3 h-8 rounded-md text-sm border border-tm-border text-tm-2 hover:bg-tm-hover hover:text-tm-1 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={13} className={reembedding ? "animate-spin" : ""} />
              {/* 手机上带文字的按钮加铃铛放不下，留图标去文字 */}
              <span className="hidden sm:inline">{reembedding ? "向量化中..." : "重新向量化"}</span>
            </button>
            <button
              onClick={handleDeleteProject}
              title="删除项目"
              disabled={deleting}
              className="flex items-center gap-1.5 px-2 sm:px-3 h-8 rounded-md text-sm border border-tm-border text-tm-2 hover:border-tm-danger hover:text-tm-danger hover:bg-tm-danger-light disabled:opacity-50 transition-colors"
            >
              <Trash2 size={13} />
              <span className="hidden sm:inline">{deleting ? "删除中..." : "删除"}</span>
            </button>
          </>
        }
      />

      <main className="max-w-4xl mx-auto px-4 sm:px-8 py-6 space-y-5">
        <SourceEntries
          projectId={id}
          uploading={refDocs.uploading}
          onFiles={(files) => void refDocs.upload(files)}
          onPickFile={() => refDocs.inputRef.current?.click()}
        />

        <ProjectAskPanel projectId={id} />

        <section className="rounded-lg border border-tm-border bg-tm-surface overflow-hidden">
          <div className="flex items-center gap-2 px-4 h-12 border-b border-tm-border-light">
            <h2 className="text-sm font-medium text-tm-1">会议</h2>
            {project.meetings && project.meetings.length > 0 && (
              <span className="text-xs text-tm-3 tabular-nums">{project.meetings.length}</span>
            )}
          </div>

          {(!project.meetings || project.meetings.length === 0) ? (
            <div className="px-4 py-8 text-center space-y-2">
              <p className="text-sm text-tm-3">还没有会议记录</p>
              <button
                onClick={() => router.push(`/projects/${id}/meetings/new`)}
                className="text-sm text-tm-brand hover:underline"
              >
                记录第一次会议
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-tm-border-light">
              {project.meetings.map((meeting) => (
                <MeetingRow key={meeting.id} meeting={meeting} projectId={id} />
              ))}
            </ul>
          )}
        </section>

        <ReferenceDocsPanel
          projectId={id}
          docs={refDocs.docs}
          loaded={refDocs.loaded}
          parsingCount={refDocs.parsingCount}
          onRemove={(doc) => void refDocs.remove(doc)}
          onPickFile={() => refDocs.inputRef.current?.click()}
        />
      </main>

      {/* 文件选择框。三入口的「上传文件」和文件区块的「上传」都点它，
          所以它放在页面级而不是任何一个子组件里。 */}
      <input
        ref={refDocs.inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => { if (e.target.files) void refDocs.upload(e.target.files); }}
      />
    </AppShell>
  );
}
