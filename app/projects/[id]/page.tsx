"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Project } from "@/app/types";
import AppHeader from "@/app/components/AppHeader";
import ProjectAskPanel from "@/app/components/ProjectAskPanel";
import ProjectMemoryPanel from "@/app/components/ProjectMemoryPanel";
import ReferenceDocsPanel from "@/app/components/ReferenceDocsPanel";
import { useConfirm } from "@/lib/ConfirmContext";

type MeetingCardData = {
  id: string;
  created_at: string;
  summary: { meta: { date: string | null; participants: string[] } };
  processing_status?: string;
  diff_status?: string | null;
};

function StatusBadge({ meeting }: { meeting: MeetingCardData }) {
  const status = meeting.processing_status;
  const diff = meeting.diff_status;

  if (status === "processing" || status === "pending") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-lark-blue-light text-lark-blue font-medium">
        处理中
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-lark-danger/10 text-lark-danger font-medium">
        生成失败
      </span>
    );
  }
  if (diff === "pending") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-lark-blue-light text-lark-blue font-medium">
        待确认主文档
      </span>
    );
  }
  return null;
}

function MeetingCard({ meeting, projectId }: { meeting: MeetingCardData; projectId: string }) {
  const { meta } = meeting.summary;
  const date = meta.date ?? new Date(meeting.created_at).toLocaleDateString("zh-CN");
  const participants = meta.participants.length > 0 ? meta.participants.join("、") : "—";

  return (
    <Link
      href={`/projects/${projectId}/meetings/${meeting.id}`}
      className="flex items-center justify-between px-5 py-4 rounded-xl border border-lark-border bg-lark-surface shadow-card hover:shadow-card-hover transition-all"
    >
      <div className="space-y-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-lark-1">{date}</span>
          <StatusBadge meeting={meeting} />
        </div>
        <div className="text-xs text-lark-3 truncate">{participants}</div>
      </div>
      <ChevronRight size={15} className="text-lark-4 shrink-0" />
    </Link>
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
      description: "项目下所有会议记录也将一并删除，此操作不可撤销。",
      confirmLabel: "删除项目",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      toast.success("项目已删除");
      router.push("/");
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => {
        // 只判 404 的话，5xx 会把 { error } 当成 project 塞进 state，
        // 随后 project.document 为 undefined，ProjectMemoryPanel 直接白屏。
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-lark-canvas">
        <p className="text-sm text-lark-3">加载中...</p>
      </div>
    );
  }

  if (notFound || !project) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-lark-canvas flex-col gap-4">
        <p className="text-sm text-lark-2">项目不存在</p>
        <Link href="/" className="text-sm text-lark-blue hover:underline">返回首页</Link>
      </div>
    );
  }

  const pendingMeetings = (project.meetings ?? []).filter((m) => m.diff_status === "pending");

  return (
    <div className="min-h-screen bg-lark-canvas">
      <AppHeader
        wide
        back={{ label: "首页", href: "/" }}
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
              className="text-sm font-semibold text-lark-1 bg-lark-sunken border border-lark-blue/40 rounded-md px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 min-w-[120px]"
              // 内联 ref 每次渲染身份都变，React 会重新挂载 ref；如果在这里调 select()，
              // 每敲一个字都会全选一次，下一个字直接把前面覆盖掉。改成挂载时选一次。
              ref={nameInputRef}
            />
          ) : (
            <span
              className="text-sm font-semibold text-lark-1 cursor-pointer hover:bg-lark-sunken rounded-md px-1 py-0.5 transition-colors"
              onDoubleClick={handleStartRename}
              title="双击重命名"
            >
              {project.name}
            </span>
          )
        }
        actions={
          <>
            <button
              onClick={handleReembed}
              disabled={reembedding}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-border text-lark-2 hover:bg-lark-sunken disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={13} className={reembedding ? "animate-spin" : ""} />
              {reembedding ? "向量化中..." : "重新向量化"}
            </button>
            <button
              onClick={handleDeleteProject}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-danger/30 text-lark-danger hover:bg-lark-danger/5 disabled:opacity-50 transition-colors"
            >
              <Trash2 size={13} />
              {deleting ? "删除中..." : "删除项目"}
            </button>
            <button
              onClick={() => router.push(`/projects/${id}/meetings/new`)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover transition-colors"
            >
              <Plus size={14} />
              新建会议
            </button>
          </>
        }
      />

      <main className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {pendingMeetings.length > 0 && (
          <button
            onClick={() => router.push(`/projects/${id}/meetings/${pendingMeetings[0].id}?diff=1`)}
            className="w-full rounded-xl border border-lark-blue/30 bg-lark-blue-light/40 px-4 py-3 flex items-center gap-3 text-left hover:bg-lark-blue-light/60 transition-colors"
          >
            <AlertCircle size={16} className="text-lark-blue shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-lark-1">
                {pendingMeetings.length} 条主文档更新建议待处理
              </p>
              <p className="text-xs text-lark-3 mt-0.5">点击进入第一条进行确认或忽略</p>
            </div>
            <ChevronRight size={14} className="text-lark-blue shrink-0" />
          </button>
        )}

        {!project.no_document && (
          <ProjectMemoryPanel
            projectId={id}
            memory={project.document}
            onUpdated={(updated) => setProject((p) => p ? { ...p, document: updated } : p)}
          />
        )}

        <ReferenceDocsPanel projectId={id} />

        <ProjectAskPanel projectId={id} blocked={pendingMeetings.length > 0} blockedCount={pendingMeetings.length} />

        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-lark-3 uppercase tracking-wider">历史会议</h2>

          {(!project.meetings || project.meetings.length === 0) && (
            <div className="rounded-xl border border-dashed border-lark-border p-8 text-center space-y-3">
              <p className="text-sm text-lark-3">还没有会议记录</p>
              <button
                onClick={() => router.push(`/projects/${id}/meetings/new`)}
                className="text-sm text-lark-blue hover:underline"
              >
                开始第一次会议
              </button>
            </div>
          )}

          {project.meetings && project.meetings.map((meeting) => (
            <MeetingCard key={meeting.id} meeting={meeting} projectId={id} />
          ))}
        </section>
      </main>
    </div>
  );
}
