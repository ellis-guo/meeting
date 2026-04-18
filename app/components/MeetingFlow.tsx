"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SummaryPanel from "./SummaryPanel";
import TranscriptPanel from "./TranscriptPanel";
import DiffPanel from "./DiffPanel";
import MeetingAskPanel from "./MeetingAskPanel";
import { Summary, Section, DocumentDiff, ProjectMemory } from "../types";
import { addLineNumbers } from "@/lib/utils";

type Phase = "idle" | "generating" | "complete";
type PopupState = { sourceLines: number[]; x: number; y: number } | null;
type ChunksWarning = { matched_lines: number; total_lines: number };
type Meta = Summary["meta"];

interface Props {
  projectId?: string;
  projectDocument?: ProjectMemory;
  onDiffConfirmed?: () => void;
}

export default function MeetingFlow({ projectId, projectDocument, onDiffConfirmed }: Props) {
  const router = useRouter();

  // Input form state
  const [transcriptInput, setTranscriptInput] = useState("");
  const [template, setTemplate] = useState<"smart" | "project">("smart");
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Generation phase
  const [phase, setPhase] = useState<Phase>("idle");
  const [streamingSections, setStreamingSections] = useState<Section[]>([]);
  const [streamingMeta, setStreamingMeta] = useState<Meta | null>(null);

  // Result state (set on done)
  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [documentDiff, setDocumentDiff] = useState<DocumentDiff | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [chunksWarning, setChunksWarning] = useState<ChunksWarning | null>(null);

  // UI state
  const [isEditing, setIsEditing] = useState(false);
  const [popup, setPopup] = useState<PopupState>(null);
  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);
  const [rechunking, setRechunking] = useState(false);

  // Q&A slide-up animation
  const [qaVisible, setQaVisible] = useState(false);
  const [qaEntered, setQaEntered] = useState(false);

  useEffect(() => {
    if (phase === "complete" && meetingId && !projectId) {
      setQaVisible(true);
      const t = setTimeout(() => setQaEntered(true), 20);
      return () => clearTimeout(t);
    }
  }, [phase, meetingId, projectId]);

  const handleGenerate = async () => {
    if (!transcriptInput.trim()) return;

    // Immediately show result layout with numbered transcript
    const numbered = addLineNumbers(transcriptInput);
    setNumberedTranscript(numbered);
    setStreamingSections([]);
    setStreamingMeta(null);
    setSummary(null);
    setDocumentDiff(null);
    setMeetingId(null);
    setChunksWarning(null);
    setGenerateError(null);
    setIsEditing(false);
    setPopup(null);
    setHighlightedLines([]);
    setQaVisible(false);
    setQaEntered(false);
    setPhase("generating");

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

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setGenerateError((data as { error?: string }).error ?? "生成失败，请重试");
        setPhase("idle");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

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
            const data = JSON.parse(dataStr);
            if (event === "meta") {
              setStreamingMeta(data as Meta);
            } else if (event === "section") {
              setStreamingSections((prev) => [...prev, data as Section]);
            } else if (event === "done") {
              setSummary(data.summary as Summary);
              setDocumentDiff(data.document_diff ?? null);
              setMeetingId(data.meeting_id ?? null);
              setChunksWarning(data.chunks_warning ?? null);
              setPhase("complete");
            } else if (event === "error") {
              setGenerateError((data as { error?: string }).error ?? "生成失败，请重试");
              setPhase("idle");
            }
          } catch { /* skip malformed event */ }
        }
      }
    } catch (e) {
      setGenerateError(String(e));
      setPhase("idle");
    }
  };

  const handleRechunk = async () => {
    if (!meetingId) return;
    setRechunking(true);
    try { await fetch(`/api/meetings/${meetingId}/rechunk`, { method: "POST" }); }
    finally { setRechunking(false); setChunksWarning(null); }
  };

  const reset = () => {
    setPhase("idle");
    setSummary(null);
    setStreamingSections([]);
    setStreamingMeta(null);
    setNumberedTranscript(null);
    setDocumentDiff(null);
    setMeetingId(null);
    setChunksWarning(null);
    setGenerateError(null);
    setQaVisible(false);
    setQaEntered(false);
  };

  // ── Idle: input form ──────────────────────────────────────────────────────
  if (phase === "idle") {
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
            {(["smart", "project"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTemplate(t)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  template === t
                    ? "bg-blue-600 text-white"
                    : "bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800"
                }`}
              >
                {t === "smart" ? "智能模板" : "项目进度"}
              </button>
            ))}
          </div>
          {generateError && <p className="text-sm text-red-500 dark:text-red-400">{generateError}</p>}
          <button
            onClick={handleGenerate}
            disabled={!transcriptInput.trim()}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            生成总结
          </button>
        </div>
      </div>
    );
  }

  // ── Generating / Complete: result layout ──────────────────────────────────
  // During generating: show partial sections from streamingSections + streamingMeta
  // During complete: show full summary
  const displaySummary: Summary = summary ?? {
    meta: streamingMeta ?? { date: null, time: null, participants: [] },
    sections: streamingSections,
    humanistic_note: null,
  };

  // Show DiffPanel on the right only for project meetings after generation is complete
  const showDiff = !!projectId && !!projectDocument && phase === "complete" && !!documentDiff;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-zinc-800 shrink-0 print:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={reset}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            ← 重新生成
          </button>
          {phase === "complete" && meetingId && (
            <button
              onClick={() => router.push(projectId ? `/projects/${projectId}/meetings/${meetingId}` : `/meetings/${meetingId}`)}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              查看详情 →
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {phase === "complete" && (
            <>
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
            </>
          )}
        </div>
      </header>

      {/* Two-pane content */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: summary (streams in section by section) */}
        <div className="w-1/2 print:w-full overflow-y-auto border-r border-gray-200 dark:border-zinc-800 print:border-none p-6 print:p-8">
          {displaySummary.sections.length > 0 ? (
            <SummaryPanel
              summary={displaySummary}
              isEditing={isEditing && phase === "complete"}
              onSourceClick={(lines, x, y) => { if (!isEditing) setPopup({ sourceLines: lines, x, y }); }}
              onSummaryChange={setSummary}
            />
          ) : (
            // Nothing yet — show subtle skeleton pulse
            <div className="space-y-4 animate-pulse">
              {[80, 60, 72, 48].map((w, i) => (
                <div key={i} className={`h-3 rounded bg-gray-100 dark:bg-zinc-800`} style={{ width: `${w}%` }} />
              ))}
            </div>
          )}

          {/* Generating indicator — shows below last section while streaming */}
          {phase === "generating" && (
            <div className="mt-4 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
              <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              AI 正在生成...
            </div>
          )}
        </div>

        {/* Right: transcript (always shown immediately) or diff (after completion for project) */}
        <div className="w-1/2 print:hidden overflow-hidden">
          {showDiff ? (
            <DiffPanel
              diff={documentDiff}
              numberedTranscript={numberedTranscript!}
              highlightedLines={highlightedLines}
              projectId={projectId!}
              projectDocument={projectDocument!}
              onConfirmed={onDiffConfirmed ?? (() => {})}
            />
          ) : (
            <div className="h-full overflow-y-auto p-6 bg-gray-50 dark:bg-zinc-900">
              <TranscriptPanel
                numberedTranscript={numberedTranscript!}
                highlightedLines={highlightedLines}
              />
            </div>
          )}
        </div>
      </div>

      {/* Q&A panel — standalone only, slides up when generation completes */}
      {qaVisible && meetingId && !projectId && (
        <div
          className={`transition-all duration-500 ease-out ${
            qaEntered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
          }`}
        >
          <MeetingAskPanel meetingId={meetingId} />
        </div>
      )}

      {/* Chunks warning dialog */}
      {chunksWarning && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 print:hidden">
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">逐字稿格式识别异常</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-5">
              仅识别到 {chunksWarning.matched_lines} / {chunksWarning.total_lines} 行，格式可能不是腾讯会议标准格式。是否使用备用方式切割逐字稿索引？
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setChunksWarning(null)} className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
                跳过，不建索引
              </button>
              <button onClick={handleRechunk} disabled={rechunking} className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
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
                onClick={() => {
                  setHighlightedLines([lineNum]);
                  document.getElementById(`line-${lineNum}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
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
