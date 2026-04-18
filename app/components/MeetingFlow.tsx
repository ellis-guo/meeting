"use client";

import { useState } from "react";
import SummaryPanel from "./SummaryPanel";
import TranscriptPanel from "./TranscriptPanel";
import DiffPanel from "./DiffPanel";
import { Summary, DocumentDiff, ProjectMemory } from "../types";

type PopupState = { sourceLines: number[]; x: number; y: number } | null;
type ChunksWarning = { matched_lines: number; total_lines: number };

interface Props {
  projectId?: string;
  projectDocument?: ProjectMemory;
  onDiffConfirmed?: () => void;
}

export default function MeetingFlow({ projectId, projectDocument, onDiffConfirmed }: Props) {
  const [transcriptInput, setTranscriptInput] = useState("");
  const [template, setTemplate] = useState<"smart" | "project">("smart");
  const [loading, setLoading] = useState(false);
  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [documentDiff, setDocumentDiff] = useState<DocumentDiff | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [popup, setPopup] = useState<PopupState>(null);
  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);
  const [chunksWarning, setChunksWarning] = useState<ChunksWarning | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [rechunking, setRechunking] = useState(false);

  const handleGenerate = async () => {
    if (!transcriptInput.trim()) return;
    setLoading(true);
    setIsEditing(false);
    try {
      const res = await fetch("/api/meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: transcriptInput,
          template,
          ...(projectId ? { project_id: projectId } : {}),
        }),
      });
      const data = await res.json();
      setNumberedTranscript(data.numbered_transcript);
      setSummary(data.summary);
      setDocumentDiff(data.document_diff ?? null);
      setMeetingId(data.meeting_id ?? null);
      setChunksWarning(data.chunks_warning ?? null);
      setPopup(null);
      setHighlightedLines([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSourceClick = (sourceLines: number[], x: number, y: number) => {
    if (isEditing) return;
    setPopup({ sourceLines, x, y });
  };

  const handleLineClick = (lineNum: number) => {
    setHighlightedLines([lineNum]);
    document.getElementById(`line-${lineNum}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const reset = () => {
    setSummary(null);
    setNumberedTranscript(null);
    setDocumentDiff(null);
    setMeetingId(null);
    setChunksWarning(null);
  };

  const handleRechunk = async () => {
    if (!meetingId) return;
    setRechunking(true);
    try {
      await fetch(`/api/meetings/${meetingId}/rechunk`, { method: "POST" });
    } finally {
      setRechunking(false);
      setChunksWarning(null);
    }
  };

  // ── Step 1: Input ──
  if (!summary || !numberedTranscript) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-8">
        <div className="w-full max-w-2xl space-y-5">
          <textarea
            className="w-full h-64 p-4 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm text-gray-800 dark:text-gray-200 bg-white dark:bg-zinc-900 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-gray-600"
            placeholder="粘贴会议记录..."
            value={transcriptInput}
            onChange={(e) => setTranscriptInput(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              onClick={() => setTemplate("smart")}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                template === "smart"
                  ? "bg-blue-600 text-white"
                  : "bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800"
              }`}
            >
              智能模板
            </button>
            <button
              onClick={() => setTemplate("project")}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                template === "project"
                  ? "bg-blue-600 text-white"
                  : "bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800"
              }`}
            >
              项目进度
            </button>
          </div>
          <button
            onClick={handleGenerate}
            disabled={loading || !transcriptInput.trim()}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "生成中..." : "生成总结"}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: Result ──
  return (
    <div className="h-screen flex flex-col bg-white dark:bg-zinc-950">
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-zinc-800 shrink-0 print:hidden">
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">会议总结</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={reset}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            ← 重新生成
          </button>
          <button
            onClick={() => { setIsEditing((v) => !v); setPopup(null); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isEditing
                ? "bg-blue-600 text-white"
                : "border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800"
            }`}
          >
            {isEditing ? "完成编辑" : "编辑"}
          </button>
          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
          >
            保存为 PDF
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Summary */}
        <div className="w-1/2 print:w-full overflow-y-auto border-r border-gray-200 dark:border-zinc-800 print:border-none p-6 print:p-8">
          <SummaryPanel
            summary={summary}
            isEditing={isEditing}
            onSourceClick={handleSourceClick}
            onSummaryChange={setSummary}
          />
        </div>

        {/* Right: Transcript or Diff */}
        <div className="w-1/2 print:hidden overflow-hidden">
          {projectId && projectDocument ? (
            <DiffPanel
              diff={documentDiff}
              numberedTranscript={numberedTranscript}
              highlightedLines={highlightedLines}
              projectId={projectId}
              projectDocument={projectDocument}
              onConfirmed={onDiffConfirmed ?? (() => {})}
            />
          ) : (
            <div className="h-full overflow-y-auto p-6 bg-gray-50 dark:bg-zinc-900">
              <TranscriptPanel
                numberedTranscript={numberedTranscript}
                highlightedLines={highlightedLines}
              />
            </div>
          )}
        </div>
      </div>

      {/* Chunks warning dialog */}
      {chunksWarning && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 print:hidden">
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">逐字稿格式识别异常</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-5">
              仅识别到 {chunksWarning.matched_lines} / {chunksWarning.total_lines} 行，格式可能不是腾讯会议标准格式。是否使用备用方式切割逐字稿索引？
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setChunksWarning(null)}
                className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                跳过，不建索引
              </button>
              <button
                onClick={handleRechunk}
                disabled={rechunking}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {rechunking ? "切割中..." : "使用备用切割"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Source popup */}
      {popup && !isEditing && (
        <div
          className="fixed bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg p-4 z-50 min-w-44 print:hidden"
          style={{ left: popup.x, top: popup.y }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">来源</span>
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
