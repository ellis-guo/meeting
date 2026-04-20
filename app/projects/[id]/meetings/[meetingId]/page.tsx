"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import SummaryPanel from "@/app/components/SummaryPanel";
import TranscriptPanel from "@/app/components/TranscriptPanel";
import DiffPanel from "@/app/components/DiffPanel";
import MeetingAskPanel from "@/app/components/MeetingAskPanel";
import { Summary, DocumentDiff, ProjectMemory } from "@/app/types";
import { addLineNumbers } from "@/lib/utils";

type PopupState = { sourceLines: number[]; x: number; y: number } | null;

export default function MeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const meetingId = params.meetingId as string;

  const [summary, setSummary] = useState<Summary | null>(null);
  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [popup, setPopup] = useState<PopupState>(null);
  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);

  // Diff / 主文档更新
  const [documentDiff, setDocumentDiff] = useState<DocumentDiff | null>(null);
  const [projectDocument, setProjectDocument] = useState<ProjectMemory | null>(null);
  const [generatingDiff, setGeneratingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [showDiffPanel, setShowDiffPanel] = useState(false);

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
      })
      .finally(() => setLoading(false));
  }, [meetingId]);

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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950">
        <p className="text-sm text-gray-400">加载中...</p>
      </div>
    );
  }

  if (notFound || !summary || !numberedTranscript) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950 flex-col gap-4">
        <p className="text-sm text-gray-500">会议记录不存在</p>
        <Link href={`/projects/${projectId}`} className="text-sm text-blue-600 hover:underline">← 返回项目</Link>
      </div>
    );
  }

  const date = summary.meta.date ?? "—";

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-zinc-950">
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-zinc-800 shrink-0 print:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(`/projects/${projectId}`)}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            ← 返回项目
          </button>
          <span className="text-gray-200 dark:text-zinc-700">|</span>
          <span className="text-sm text-gray-600 dark:text-gray-400">{date}</span>
        </div>
        <div className="flex items-center gap-2">
          {!showDiffPanel && (
            <>
              <button
                onClick={() => { setIsEditing((v) => !v); setPopup(null); }}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isEditing
                    ? "bg-blue-600 text-white"
                    : "border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800"
                }`}
              >
                {isEditing ? "取消" : "编辑"}
              </button>
              {isEditing && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
              )}
              <button
                onClick={handleGenerateDiff}
                disabled={generatingDiff}
                className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors"
              >
                {generatingDiff ? "生成中..." : "更新主文档"}
              </button>
            </>
          )}
          {showDiffPanel && (
            <button
              onClick={() => setShowDiffPanel(false)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
            >
              ← 返回摘要
            </button>
          )}
          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors print:hidden"
          >
            PDF
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-red-200 dark:border-red-900 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 transition-colors"
          >
            {deleting ? "删除中..." : "删除"}
          </button>
        </div>
      </header>

      {diffError && (
        <div className="px-6 py-2 bg-red-50 dark:bg-red-950/30 border-b border-red-100 dark:border-red-900 shrink-0">
          <p className="text-xs text-red-500">{diffError}</p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: summary (hidden when diff panel is fullscreen on mobile, always visible on desktop) */}
        <div className={`${showDiffPanel ? "hidden md:block" : ""} w-1/2 print:w-full overflow-y-auto border-r border-gray-200 dark:border-zinc-800 print:border-none p-6 print:p-8`}>
          <SummaryPanel
            summary={summary}
            isEditing={isEditing}
            onSourceClick={handleSourceClick}
            onSummaryChange={setSummary}
          />
        </div>

        {/* Right: TranscriptPanel or DiffPanel */}
        <div className={`${showDiffPanel ? "w-full md:w-1/2" : "w-1/2"} print:hidden overflow-hidden flex flex-col`}>
          {showDiffPanel && documentDiff && projectDocument ? (
            <DiffPanel
              diff={documentDiff}
              numberedTranscript={numberedTranscript}
              highlightedLines={highlightedLines}
              projectId={projectId}
              projectDocument={projectDocument}
              onConfirmed={() => setShowDiffPanel(false)}
            />
          ) : (
            <div className="flex-1 overflow-y-auto p-6 bg-gray-50 dark:bg-zinc-900">
              <TranscriptPanel
                numberedTranscript={numberedTranscript}
                highlightedLines={highlightedLines}
              />
            </div>
          )}
        </div>
      </div>

      {!showDiffPanel && <MeetingAskPanel meetingId={meetingId} />}

      {popup && !isEditing && (
        <div
          className="fixed bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg p-4 z-50 min-w-44 print:hidden"
          style={{ left: popup.x, top: popup.y }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">来源</span>
            <button onClick={() => setPopup(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none ml-4">×</button>
          </div>
          <div className="flex flex-col gap-1.5">
            {popup.sourceLines.map((lineNum, i) => (
              <button
                key={lineNum}
                onClick={() => handleLineClick(lineNum)}
                className="text-left text-sm text-blue-600 dark:text-blue-400 hover:underline"
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
