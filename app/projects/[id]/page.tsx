"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Plus, RefreshCw, Send, Trash2, Download } from "lucide-react";
import { Project } from "@/app/types";
import ProjectMemoryPanel from "@/app/components/ProjectMemoryPanel";
import NotificationBell from "@/app/components/NotificationBell";

const SOURCES_SEP = "%%SOURCES%%";

type AskSource = {
  meeting_id: string | null;
  chunk_type: string;
  section_title: string | null;
  speaker: string | null;
  meeting_date: string | null;
};

type CitationResolver = (date: string, section: string) => string | null;

function renderInline(text: string, resolve?: CitationResolver): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\[\d{4}-\d{2}-\d{2}\s*·[^\]]+\]|\[[^\]]+·[^\]]+\])/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (resolve) {
      const m = part.match(/^\[(\d{4}-\d{2}-\d{2})\s*·\s*([^\]]+)\]$/);
      if (m) {
        const href = resolve(m[1], m[2].trim());
        return href
          ? <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-lark-border text-lark-3 hover:text-lark-blue transition-colors text-xs">{part}</a>
          : <span key={i} className="text-lark-4 text-xs">{part}</span>;
      }
      if (/^\[[^\]]+·[^\]]+\]$/.test(part)) {
        return <span key={i} className="text-lark-4 text-xs">{part}</span>;
      }
    }
    return part;
  });
}

function renderAnswer(text: string, resolve?: CitationResolver): React.ReactNode {
  const rawLines = text.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (/^[•*]\s*$/.test(rawLines[i]) && i + 1 < rawLines.length && rawLines[i + 1].trim() !== "") {
      lines.push(`* ${rawLines[i + 1].trim()}`);
      i++;
    } else {
      lines.push(rawLines[i]);
    }
  }

  return lines.map((line, i) => {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    const bullet = line.match(/^[*•]\s+(.+)/);
    if (h2) return <p key={i} className="text-base font-semibold text-lark-1 mt-4 mb-0.5">{renderInline(h2[1], resolve)}</p>;
    if (h3) return <p key={i} className="font-medium text-lark-1 mt-3 mb-0.5">{renderInline(h3[1], resolve)}</p>;
    if (bullet) return <p key={i} className="flex gap-2 pl-2"><span className="shrink-0 text-lark-3">•</span><span>{renderInline(bullet[1], resolve)}</span></p>;
    if (line === "") return <br key={i} />;
    return <Fragment key={i}>{renderInline(line, resolve)}<br /></Fragment>;
  });
}

type ProjectMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources?: AskSource[];
  debug?: object;
  isStreaming?: boolean;
  error?: string;
};

function stripSources(text: string): string {
  const sepIdx = text.indexOf(SOURCES_SEP);
  return sepIdx !== -1 ? text.slice(0, sepIdx).trimEnd() : text;
}

function ProjectAskPanel({ projectId, blocked, blockedCount }: { projectId: string; blocked: boolean; blockedCount: number }) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<ProjectMessage[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset history on project change
  useEffect(() => {
    setMessages([]);
    setQuestion("");
  }, [projectId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (collapsed) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, collapsed]);

  const updateLastAssistant = (patch: Partial<ProjectMessage>) => {
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant") {
          copy[i] = { ...copy[i], ...patch };
          break;
        }
      }
      return copy;
    });
  };

  const handleDownloadDebug = (msg: ProjectMessage, userText: string) => {
    if (!msg.debug) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const q = userText.trim().slice(0, 10).replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([JSON.stringify(msg.debug, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `debug_${ts}_${q}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAsk = async () => {
    const q = question.trim();
    if (!q || asking || blocked) return;

    const userMsg: ProjectMessage = { id: `u-${Date.now()}`, role: "user", text: q };
    const assistantMsg: ProjectMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      text: "",
      isStreaming: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setQuestion("");
    setAsking(true);
    if (collapsed) setCollapsed(false);

    try {
      const res = await fetch(`/api/projects/${projectId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });

      if (!res.ok) {
        let msg = `请求失败 (${res.status})`;
        try {
          const data = await res.json();
          msg = data.error ?? msg;
        } catch { /* keep default */ }
        updateLastAssistant({ isStreaming: false, error: msg });
        return;
      }

      if (!res.body) {
        updateLastAssistant({ isStreaming: false, error: "请求失败" });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";

        for (const block of blocks) {
          const event = block.match(/^event: (\w+)/)?.[1];
          const dataStr = block.match(/^data: (.+)$/m)?.[1];
          if (!event || !dataStr) continue;
          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            if (event === "token") {
              acc += (data.text as string) ?? "";
              updateLastAssistant({ text: stripSources(acc) });
            } else if (event === "done") {
              const sources = Array.isArray(data.sources) ? (data.sources as AskSource[]) : [];
              const debug = data._debug !== undefined ? (data._debug as object) : undefined;
              updateLastAssistant({ sources, debug, isStreaming: false });
            } else if (event === "error") {
              updateLastAssistant({
                isStreaming: false,
                error: (data.error as string) ?? "请求失败",
              });
            }
          } catch { /* skip malformed */ }
        }
      }
      updateLastAssistant({ isStreaming: false });
    } catch {
      updateLastAssistant({ isStreaming: false, error: "网络错误，请重试" });
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

  const handleClear = () => {
    if (messages.length === 0) return;
    if (!window.confirm("清空当前会话历史？")) return;
    setMessages([]);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-lark-3 uppercase tracking-wider">项目问答</h2>
        {messages.length > 0 && (
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-1 text-xs text-lark-3 hover:text-lark-1 transition-colors"
            title={collapsed ? "展开历史" : "收起历史"}
          >
            {collapsed ? (
              <>
                <ChevronUp size={12} />
                展开历史 ({messages.filter((m) => m.role === "user").length})
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

        {/* Messages */}
        {messages.length > 0 && !collapsed && (
          <div className="px-4 py-4 max-h-[36rem] overflow-y-auto space-y-3 border-b border-lark-border">
            {messages.map((m, idx) => {
              const prevUser = idx > 0 && messages[idx - 1].role === "user" ? messages[idx - 1].text : "";
              return (
                <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                      m.role === "user"
                        ? "bg-lark-blue text-white rounded-br-sm"
                        : m.error
                          ? "bg-lark-danger/5 border border-lark-danger/30 text-lark-danger rounded-bl-sm"
                          : "bg-lark-sunken text-lark-1 rounded-bl-sm"
                    }`}
                  >
                    {m.role === "user" ? (
                      <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                    ) : m.error ? (
                      <p className="leading-relaxed">{m.error}</p>
                    ) : (
                      <>
                        <div className="leading-relaxed">
                          {m.text
                            ? renderAnswer(m.text, (date, _section) => {
                                // 优先精确匹配 date + section_title；回退到仅 date 匹配
                                const exact = m.sources?.find(
                                  (src) => src.meeting_date === date && src.section_title?.trim() === _section && src.meeting_id,
                                );
                                const fallback = m.sources?.find(
                                  (src) => src.meeting_date === date && src.meeting_id,
                                );
                                const s = exact ?? fallback;
                                return s?.meeting_id ? `/projects/${projectId}/meetings/${s.meeting_id}` : null;
                              })
                            : <span className="text-lark-3">思考中...</span>}
                        </div>
                        {!m.isStreaming && m.debug && (
                          <div className="mt-2 pt-2 border-t border-lark-border flex justify-end">
                            <button
                              onClick={() => handleDownloadDebug(m, prevUser)}
                              className="flex items-center gap-1 text-[11px] text-lark-3 hover:text-lark-2 transition-colors"
                            >
                              <Download size={11} />
                              下载 Debug
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input */}
        <div className="p-4 space-y-2">
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={blocked ? "请先处理待确认的主文档更新..." : "针对整个项目历史提问，按 Enter 发送..."}
              rows={1}
              disabled={blocked}
              className="flex-1 resize-none rounded-lg border border-lark-border bg-lark-sunken px-3 py-2 text-sm text-lark-1 placeholder:text-lark-4 focus:outline-none focus:ring-1 focus:ring-lark-blue/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            />
            <button
              onClick={handleAsk}
              disabled={asking || !question.trim() || blocked}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              <Send size={13} />
              {asking ? "思考中..." : "提问"}
            </button>
          </div>
          {messages.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={handleClear}
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
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

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
    if (!window.confirm(`确认删除项目「${project?.name}」？项目下所有会议记录也将一并删除，此操作不可撤销。`)) return;
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
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setProject(data); })
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
      <header className="px-8 py-4 border-b border-lark-border bg-lark-surface flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 transition-colors">
            <ArrowLeft size={14} />
            首页
          </Link>
          <span className="text-lark-border">|</span>
          {editingName ? (
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
              ref={(el) => { if (el) el.select(); }}
            />
          ) : (
            <span
              className="text-sm font-semibold text-lark-1 cursor-pointer hover:bg-lark-sunken rounded-md px-1 py-0.5 transition-colors"
              onDoubleClick={handleStartRename}
              title="双击重命名"
            >
              {project.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
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
          <NotificationBell />
        </div>
      </header>

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

        <ProjectMemoryPanel
          projectId={id}
          memory={project.document}
          onUpdated={(updated) => setProject((p) => p ? { ...p, document: updated } : p)}
        />

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
