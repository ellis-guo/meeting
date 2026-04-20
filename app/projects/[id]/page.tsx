"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Project } from "@/app/types";
import ProjectMemoryPanel from "@/app/components/ProjectMemoryPanel";

type AskSource = {
  meeting_id: string;
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  meeting_date: string | null;
};

function ProjectAskPanel({ projectId }: { projectId: string }) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<AskSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleAsk = async () => {
    if (!question.trim() || asking) return;
    setAsking(true);
    setAnswer(null);
    setSources([]);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "请求失败");
      } else {
        setAnswer(data.answer ?? null);
        setSources(Array.isArray(data.sources) ? data.sources : []);
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setAsking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">项目问答</h2>
      <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="针对整个项目历史提问，按 Enter 发送..."
            rows={2}
            className="flex-1 resize-none rounded-lg border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={handleAsk}
            disabled={asking || !question.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {asking ? "思考中..." : "提问"}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
        )}

        {answer !== null && (
          <div className="space-y-3 pt-1 border-t border-gray-100 dark:border-zinc-800">
            <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed whitespace-pre-wrap">{answer}</p>
            {sources.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">来源</p>
                <div className="flex flex-wrap gap-2">
                  {sources.map((s, i) => (
                    <Link
                      key={i}
                      href={`/projects/${projectId}/meetings/${s.meeting_id}`}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      {s.meeting_date && <span>{s.meeting_date}</span>}
                      {s.meeting_date && (s.section_title || s.speaker) && <span className="text-gray-300 dark:text-zinc-600">·</span>}
                      {s.section_title ?? s.speaker ?? "片段"}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function MeetingCard({ meeting, projectId }: { meeting: { id: string; created_at: string; summary: { meta: { date: string | null; participants: string[] } } }; projectId: string }) {
  const { meta } = meeting.summary;
  const date = meta.date ?? new Date(meeting.created_at).toLocaleDateString("zh-CN");
  const participants = meta.participants.length > 0 ? meta.participants.join("、") : "—";

  return (
    <Link
      href={`/projects/${projectId}/meetings/${meeting.id}`}
      className="flex items-center justify-between px-5 py-4 rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm transition-all"
    >
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{date}</div>
        <div className="text-xs text-gray-400 dark:text-gray-500">{participants}</div>
      </div>
      <span className="text-gray-300 dark:text-gray-600 text-sm">→</span>
    </Link>
  );
}

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const [reembedResult, setReembedResult] = useState<string | null>(null);

  const handleReembed = async () => {
    setReembedding(true);
    setReembedResult(null);
    try {
      const res = await fetch(`/api/projects/${id}/reembed`, { method: "POST" });
      const data = await res.json();
      setReembedResult(data.message ?? (res.ok ? "完成" : data.error ?? "失败"));
    } catch {
      setReembedResult("网络错误，请重试");
    } finally {
      setReembedding(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!window.confirm(`确认删除项目「${project?.name}」？项目下所有会议记录也将一并删除，此操作不可撤销。`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      router.push("/");
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setProject(data); })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950">
        <p className="text-sm text-gray-400">加载中...</p>
      </div>
    );
  }

  if (notFound || !project) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950 space-y-4 flex-col">
        <p className="text-sm text-gray-500">项目不存在</p>
        <Link href="/" className="text-sm text-blue-600 hover:underline">← 返回首页</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950">
      <header className="px-8 py-5 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">← 首页</Link>
          <span className="text-gray-200 dark:text-zinc-700">|</span>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{project.name}</span>
        </div>
        <div className="flex items-center gap-2">
        {reembedResult && (
          <span className="text-xs text-gray-500 dark:text-gray-400">{reembedResult}</span>
        )}
        <button
          onClick={handleReembed}
          disabled={reembedding}
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors"
        >
          {reembedding ? "向量化中..." : "重新向量化"}
        </button>
        <button
          onClick={handleDeleteProject}
          disabled={deleting}
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-red-200 dark:border-red-900 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 transition-colors"
        >
          {deleting ? "删除中..." : "删除项目"}
        </button>
        <button
          onClick={() => router.push(`/projects/${id}/meetings/new`)}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
        >
          + 新建会议
        </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-8 py-8 space-y-6">
        {/* Project memory */}
        <ProjectMemoryPanel
          projectId={id}
          memory={project.document}
          onUpdated={(updated) => setProject((p) => p ? { ...p, document: updated } : p)}
        />

        {/* Project Q&A */}
        <ProjectAskPanel projectId={id} />

        {/* Meetings */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">历史会议</h2>

          {(!project.meetings || project.meetings.length === 0) && (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-zinc-800 p-8 text-center space-y-3">
              <p className="text-sm text-gray-400">还没有会议记录</p>
              <button
                onClick={() => router.push(`/projects/${id}/meetings/new`)}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                开始第一次会议 →
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
