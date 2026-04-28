"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, Pencil, Printer, Trash2, X } from "lucide-react";
import SummaryPanel from "@/app/components/SummaryPanel";
import TranscriptPanel from "@/app/components/TranscriptPanel";
import DiffPanel from "@/app/components/DiffPanel";
import MeetingAskPanel from "@/app/components/MeetingAskPanel";
import NotificationBell from "@/app/components/NotificationBell";
import { Summary, DocumentDiff, ProjectMemory } from "@/app/types";
import { addLineNumbers } from "@/lib/utils";

type PopupState = { sourceLines: number[]; x: number; y: number } | null;

export default function MeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const meetingId = params.meetingId as string;
  const wantDiff = searchParams.get("diff") === "1";

  const [summary, setSummary] = useState<Summary | null>(null);
  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [popup, setPopup] = useState<PopupState>(null);
  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);

  const [documentDiff, setDocumentDiff] = useState<DocumentDiff | null>(null);
  const [projectDocument, setProjectDocument] = useState<ProjectMemory | null>(null);
  const [generatingDiff, setGeneratingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [showDiffPanel, setShowDiffPanel] = useState(false);
  const [diffStatus, setDiffStatus] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [diffPos, setDiffPos] = useState<{ x: number; y: number } | null>(null);
  const autoOpenedOnceRef = useRef(false);

  // 首次打开浮窗时设定初始位置（屏幕右上）
  useEffect(() => {
    if (showDiffPanel && diffPos === null && typeof window !== "undefined") {
      setDiffPos({ x: window.innerWidth - 520 - 24, y: 80 });
    }
  }, [showDiffPanel, diffPos]);

  const handleDiffDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!diffPos) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = { ...diffPos };
    const onMove = (ev: MouseEvent) => {
      setDiffPos({
        x: Math.max(0, Math.min(window.innerWidth - 100, startPos.x + ev.clientX - startX)),
        y: Math.max(0, Math.min(window.innerHeight - 60, startPos.y + ev.clientY - startY)),
      });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const loadProjectDoc = async () => {
    const r = await fetch(`/api/projects/${projectId}`);
    if (r.ok) {
      const d = await r.json();
      setProjectDocument(d.document as ProjectMemory);
    }
  };

  useEffect(() => {
    fetch(`/api/meetings/${meetingId}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => {
        if (!data) return;
        setSummary(data.summary as Summary);
        setNumberedTranscript(addLineNumbers(data.transcript as string));
        setDiffStatus(data.diff_status ?? null);
        setProcessingStatus(data.processing_status ?? null);
        if (data.diff_status === "pending" && data.document_diff) {
          setDocumentDiff(data.document_diff as DocumentDiff);
        }
      })
      .finally(() => setLoading(false));
  }, [meetingId]);

  // 仅当 URL 带 ?diff=1（来自通知或项目页 banner 跳转）才**首次**自动展开 DiffPanel。
  // 用户关闭后不再重新自动展开（autoOpenedOnceRef 锁住）。
  // 直接 URL 访问 / 项目页直接点击 → 不自动展开，由 header 上的"主文档建议"按钮手动触发。
  useEffect(() => {
    if (wantDiff && !autoOpenedOnceRef.current && diffStatus === "pending" && documentDiff && !projectDocument) {
      loadProjectDoc();
    }
  }, [wantDiff, diffStatus, documentDiff, projectDocument]);

  useEffect(() => {
    if (wantDiff && !autoOpenedOnceRef.current && diffStatus === "pending" && documentDiff && projectDocument) {
      setShowDiffPanel(true);
      autoOpenedOnceRef.current = true;
    }
  }, [wantDiff, diffStatus, documentDiff, projectDocument]);

  const openDiffDrawer = async () => {
    if (!documentDiff) return;
    if (!projectDocument) await loadProjectDoc();
    setShowDiffPanel(true);
  };

  // Poll while diff is being generated in background
  useEffect(() => {
    if (processingStatus !== "processing" && processingStatus !== "pending") return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/meetings/${meetingId}`);
      if (!r.ok) return;
      const d = await r.json();
      setProcessingStatus(d.processing_status ?? null);
      setDiffStatus(d.diff_status ?? null);
      if (d.document_diff) setDocumentDiff(d.document_diff as DocumentDiff);
      if (d.processing_status === "done" || d.processing_status === "failed") {
        clearInterval(t);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [meetingId, processingStatus]);

  const handleSourceClick = (sourceLines: number[], x: number, y: number) => {
    if (isEditing) return;
    setPopup({ sourceLines, x, y });
  };

  const handleLineClick = (lineNum: number) => {
    setHighlightedLines([lineNum]);
    document.getElementById(`line-${lineNum}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleSave = async () => {
    if (!summary) return;
    setSaving(true);
    try {
      await fetch(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("确认删除这条会议记录？此操作不可撤销。")) return;
    setDeleting(true);
    try {
      await fetch(`/api/meetings/${meetingId}`, { method: "DELETE" });
      toast.success("会议记录已删除");
      router.push(`/projects/${projectId}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleGenerateDiff = async () => {
    setGeneratingDiff(true);
    setDiffError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/meetings/${meetingId}/diff`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "生成失败");
      setDocumentDiff(data.document_diff as DocumentDiff);
      setProjectDocument(data.project_document as ProjectMemory);
      setShowDiffPanel(true);
    } catch (e) {
      setDiffError(String(e));
    } finally {
      setGeneratingDiff(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-lark-canvas">
        <p className="text-sm text-lark-3">加载中...</p>
      </div>
    );
  }

  if (notFound || !summary || !numberedTranscript) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-lark-canvas flex-col gap-4">
        <p className="text-sm text-lark-2">会议记录不存在</p>
        <Link href={`/projects/${projectId}`} className="text-sm text-lark-blue hover:underline">返回项目</Link>
      </div>
    );
  }

  const date = summary.meta.date ?? "—";

  return (
    <div className="h-screen flex flex-col bg-lark-surface">
      <header className="flex items-center justify-between px-6 py-3 border-b border-lark-border shrink-0 print:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`/projects/${projectId}`)}
            className="flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 transition-colors"
          >
            <ArrowLeft size={14} />
            返回项目
          </button>
          <span className="text-lark-border">|</span>
          <span className="text-sm text-lark-2">{date}</span>
        </div>
        <div className="flex items-center gap-2">
          {diffStatus === "pending" && documentDiff && !showDiffPanel && (
            <button
              onClick={openDiffDrawer}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-lark-blue-light text-lark-blue hover:bg-lark-blue-light/70 border border-lark-blue/20 transition-colors"
            >
              <AlertCircle size={13} />
              查看主文档建议
            </button>
          )}
          <button
            onClick={() => { setIsEditing((v) => !v); setPopup(null); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isEditing
                ? "bg-lark-blue text-white"
                : "border border-lark-border text-lark-2 hover:bg-lark-sunken"
            }`}
          >
            <Pencil size={13} />
            {isEditing ? "完成编辑" : "编辑"}
          </button>
          {isEditing && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 transition-colors"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          )}
          <button
            onClick={handleGenerateDiff}
            disabled={generatingDiff}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-border text-lark-2 hover:bg-lark-sunken disabled:opacity-50 transition-colors"
          >
            {generatingDiff ? "生成中..." : "更新主文档"}
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-border text-lark-2 hover:bg-lark-sunken transition-colors print:hidden"
          >
            <Printer size={13} />
            导出 PDF
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-danger/30 text-lark-danger hover:bg-lark-danger/5 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={13} />
            {deleting ? "删除中..." : "删除"}
          </button>
          <NotificationBell />
        </div>
      </header>

      {diffError && (
        <div className="px-6 py-2 bg-lark-danger/5 border-b border-lark-danger/20 shrink-0">
          <p className="text-xs text-lark-danger">{diffError}</p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className={`${showDiffPanel ? "hidden md:block" : ""} w-1/2 print:w-full overflow-y-auto border-r border-lark-border print:border-none p-6 print:p-8`}>
          <SummaryPanel
            summary={summary}
            isEditing={isEditing}
            onSourceClick={handleSourceClick}
            onSummaryChange={setSummary}
          />
        </div>

        <div className="w-1/2 print:hidden overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto p-6 bg-lark-sunken">
            <TranscriptPanel
              numberedTranscript={numberedTranscript}
              highlightedLines={highlightedLines}
            />
          </div>
        </div>
      </div>

      <MeetingAskPanel meetingId={meetingId} onLineClick={handleLineClick} />

      {/* DiffPanel 以可拖动浮窗形式弹出；不阻塞页面其他交互；× 关闭仅隐藏，diff_status 不变 */}
      {showDiffPanel && documentDiff && projectDocument && diffPos && (
        <aside
          className="fixed bg-lark-surface rounded-xl border border-lark-border z-40 print:hidden flex flex-col"
          style={{
            left: diffPos.x,
            top: diffPos.y,
            width: 520,
            height: "min(700px, calc(100vh - 120px))",
            boxShadow: "var(--lark-shadow-modal)",
          }}
        >
          <div
            onMouseDown={handleDiffDragStart}
            className="flex items-center justify-between px-4 py-2.5 border-b border-lark-border shrink-0 cursor-move select-none rounded-t-xl bg-lark-sunken"
          >
            <span className="text-sm font-semibold text-lark-1">主文档更新建议</span>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setShowDiffPanel(false)}
              className="p-1 rounded-md text-lark-3 hover:text-lark-1 hover:bg-lark-surface transition-colors cursor-pointer"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <DiffPanel
              diff={documentDiff}
              projectId={projectId}
              meetingId={meetingId}
              projectDocument={projectDocument}
              meetingDate={summary.meta.date ?? new Date().toISOString().slice(0, 10)}
              onConfirmed={() => {
                setShowDiffPanel(false);
                setDocumentDiff(null);
                setDiffStatus("confirmed");
              }}
              onDismissed={() => {
                setShowDiffPanel(false);
                setDocumentDiff(null);
                setDiffStatus("dismissed");
              }}
            />
          </div>
        </aside>
      )}

      {popup && !isEditing && (
        <div
          className="fixed bg-lark-surface border border-lark-border rounded-xl p-4 z-50 min-w-44 print:hidden"
          style={{ left: popup.x, top: Math.min(popup.y, window.innerHeight - 220), boxShadow: "var(--lark-shadow-modal)" }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-lark-3 uppercase tracking-wider">来源</span>
            <button onClick={() => setPopup(null)} className="text-lark-3 hover:text-lark-1 transition-colors ml-4">
              <X size={14} />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {popup.sourceLines.map((lineNum, i) => (
              <button
                key={lineNum}
                onClick={() => handleLineClick(lineNum)}
                className="text-left text-sm text-lark-blue hover:underline"
              >
                来源 {i + 1}（第 {lineNum} 行）
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
