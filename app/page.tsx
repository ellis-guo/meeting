"use client";

import { useState } from "react";
import SummaryPanel from "./components/SummaryPanel";
import TranscriptPanel from "./components/TranscriptPanel";
import { Summary } from "./types";

type PopupState = {
  sourceLines: number[];
  x: number;
  y: number;
} | null;

export default function Home() {
  const [transcriptInput, setTranscriptInput] = useState("");
  const [template, setTemplate] = useState<"smart" | "project">("smart");
  const [loading, setLoading] = useState(false);
  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [popup, setPopup] = useState<PopupState>(null);

  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);

  const handleGenerate = async () => {
    if (!transcriptInput.trim()) return;
    setLoading(true);
    setIsEditing(false);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: transcriptInput, template }),
      });
      const data = await res.json();
      setNumberedTranscript(data.numbered_transcript);
      setSummary(data.summary);
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
    document.getElementById(`line-${lineNum}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  };

  const handleSavePDF = () => window.print();

  if (!summary || !numberedTranscript) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-8">
        <div className="w-full max-w-2xl space-y-5">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            会议总结
          </h1>

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

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-zinc-950">
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shrink-0 print:hidden">
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          会议总结
        </h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setSummary(null); setNumberedTranscript(null); }}
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
            onClick={handleSavePDF}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
          >
            保存为 PDF
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 print:w-full overflow-y-auto border-r border-gray-200 dark:border-zinc-800 print:border-none p-6 print:p-8">
          <SummaryPanel
            summary={summary}
            isEditing={isEditing}
            onSourceClick={handleSourceClick}
            onSummaryChange={setSummary}
          />
        </div>
        <div className="w-1/2 print:hidden overflow-y-auto p-6 bg-gray-50 dark:bg-zinc-900">
          <TranscriptPanel
            numberedTranscript={numberedTranscript}
            highlightedLines={highlightedLines}
          />
        </div>
      </div>

      {popup && !isEditing && (
        <div
          className="fixed bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg p-4 z-50 min-w-44 print:hidden"
          style={{ left: popup.x, top: popup.y }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
              来源
            </span>
            <button
              onClick={() => setPopup(null)}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none ml-4"
            >
              ×
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {popup.sourceLines.map((lineNum, i) => (
              <button
                key={lineNum}
                onClick={() => handleLineClick(lineNum)}
                className="text-left text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
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
