"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, Pencil, Printer, RotateCcw, X } from "lucide-react";
import SummaryPanel from "./SummaryPanel";
import TranscriptPanel from "./TranscriptPanel";
import DiffPanel from "./DiffPanel";
import MeetingAskPanel from "./MeetingAskPanel";
import NotificationBell from "./NotificationBell";
import { Summary, Section, DocumentDiff, ProjectMemory } from "../types";
import { addLineNumbers } from "@/lib/utils";
import { useApiKey } from "@/lib/ApiKeyContext";

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
  const { status: keyStatus, promptApiKey } = useApiKey();

  const [transcriptInput, setTranscriptInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  const [template, setTemplate] = useState<"smart" | "project">("smart");
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [streamingSections, setStreamingSections] = useState<Section[]>([]);
  const [streamingMeta, setStreamingMeta] = useState<Meta | null>(null);

  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [documentDiff, setDocumentDiff] = useState<DocumentDiff | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [chunksWarning, setChunksWarning] = useState<ChunksWarning | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [popup, setPopup] = useState<PopupState>(null);
  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);
  const [rechunking, setRechunking] = useState(false);

  const [qaVisible, setQaVisible] = useState(false);
  const [qaEntered, setQaEntered] = useState(false);

  useEffect(() => {
    if (phase === "complete" && meetingId) {
      setQaVisible(true);
      const t = setTimeout(() => setQaEntered(true), 20);
      return () => clearTimeout(t);
    }
  }, [phase, meetingId]);

  const handleGenerate = async () => {
    if (!transcriptInput.trim()) return;
    if (!keyStatus.configured) { promptApiKey(); return; }

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
          date: dateInput,
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
              // document_diff 不再随 SSE 返回，由后台异步生成并落库；
              // 项目会议在详情页通过 meeting.document_diff 渲染 DiffPanel。
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

  const handleReset = () => {
    if (phase === "generating") return;
    if (phase === "complete" && !window.confirm("确认重新生成？当前内容将被清除。")) return;
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
      <div className="min-h-full flex items-center justify-center bg-lark-canvas p-8">
        <div className="w-full max-w-2xl space-y-4">
          <textarea
            className="w-full h-64 p-4 border border-lark-border rounded-xl text-sm text-lark-1 bg-lark-surface resize-none focus:outline-none focus:ring-2 focus:ring-lark-blue/40 placeholder:text-lark-4 shadow-card transition-colors"
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
                    ? "bg-lark-blue text-white"
                    : "bg-lark-surface border border-lark-border text-lark-2 hover:bg-lark-sunken"
                }`}
              >
                {t === "smart" ? "智能模板" : "项目进度"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm text-lark-2 shrink-0">会议日期</label>
            <input
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              required
              className="flex-1 px-3 py-2 border border-lark-border rounded-lg text-sm text-lark-1 bg-lark-surface focus:outline-none focus:ring-2 focus:ring-lark-blue/40 transition-colors"
            />
          </div>
          {generateError && <p className="text-sm text-lark-danger">{generateError}</p>}
          <button
            onClick={handleGenerate}
            disabled={!transcriptInput.trim() || !dateInput}
            className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            生成总结
          </button>
        </div>
      </div>
    );
  }

  // ── Generating / Complete: result layout ──────────────────────────────────
  const displaySummary: Summary = summary ?? {
    meta: streamingMeta ?? { date: null, time: null, participants: [] },
    sections: streamingSections,
    humanistic_note: null,
  };

  const showDiff = !!projectId && !!projectDocument && phase === "complete" && !!documentDiff;

  return (
    <div className="h-full flex flex-col bg-lark-surface">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-lark-border shrink-0 print:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={handleReset}
            disabled={phase === "generating"}
            className="flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 disabled:opacity-40 transition-colors"
          >
            <RotateCcw size={13} />
            重新生成
          </button>
        </div>
        <div className="flex items-center gap-2">
          {phase === "complete" && (
            <>
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
              <button
                onClick={() => window.print()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-border text-lark-2 hover:bg-lark-sunken transition-colors"
              >
                <Printer size={13} />
                导出 PDF
              </button>
            </>
          )}
          <NotificationBell />
        </div>
      </header>

      {/* Two-pane content */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: summary */}
        <div className="w-1/2 print:w-full overflow-y-auto border-r border-lark-border print:border-none p-6 print:p-8">
          {displaySummary.sections.length > 0 ? (
            <SummaryPanel
              summary={displaySummary}
              isEditing={isEditing && phase === "complete"}
              onSourceClick={(lines, x, y) => { if (!isEditing) setPopup({ sourceLines: lines, x, y }); }}
              onSummaryChange={setSummary}
            />
          ) : (
            <div className="space-y-3 animate-pulse">
              {[80, 60, 72, 48].map((w, i) => (
                <div key={i} className="h-3 rounded bg-lark-border" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}

          {phase === "generating" && (
            <div className="mt-4 flex items-center gap-2 text-xs text-lark-3">
              <div className="w-3 h-3 border-2 border-lark-blue border-t-transparent rounded-full animate-spin" />
              AI 正在生成...
            </div>
          )}
        </div>

        {/* Right: transcript （创建流程下不再内嵌 diff，diff 在 meeting 详情页通过浮窗处理） */}
        <div className="w-1/2 print:hidden overflow-hidden">
          <div className="h-full overflow-y-auto p-6 bg-lark-sunken">
            <TranscriptPanel
              numberedTranscript={numberedTranscript!}
              highlightedLines={highlightedLines}
            />
          </div>
        </div>
      </div>

      {/* Q&A panel */}
      {qaVisible && meetingId && (
        <div
          className={`transition-all duration-500 ease-out ${
            qaEntered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
          }`}
        >
          <MeetingAskPanel
            meetingId={meetingId}
            onLineClick={(lineNum) => {
              setHighlightedLines([lineNum]);
              document.getElementById(`line-${lineNum}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          />
        </div>
      )}

      {/* Chunks warning dialog */}
      {chunksWarning && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 print:hidden">
          <div className="bg-lark-surface rounded-xl p-6 max-w-sm w-full mx-4" style={{ boxShadow: "var(--lark-shadow-modal)" }}>
            <h2 className="text-sm font-semibold text-lark-1 mb-2">逐字稿格式识别异常</h2>
            <p className="text-sm text-lark-2 mb-5">
              仅识别到 {chunksWarning.matched_lines} / {chunksWarning.total_lines} 行，格式可能不是腾讯会议标准格式。是否使用备用方式切割逐字稿索引？
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setChunksWarning(null)} className="px-4 py-2 text-sm text-lark-2 hover:text-lark-1 transition-colors">
                跳过，不建索引
              </button>
              <button onClick={handleRechunk} disabled={rechunking} className="px-4 py-2 text-sm font-medium bg-lark-blue text-white rounded-lg hover:bg-lark-blue-hover disabled:opacity-50 transition-colors">
                {rechunking ? "切割中..." : "使用备用切割"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Source popup */}
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
                onClick={() => {
                  setHighlightedLines([lineNum]);
                  document.getElementById(`line-${lineNum}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
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
