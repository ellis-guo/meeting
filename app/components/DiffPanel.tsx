"use client";

import { useState } from "react";
import { DocumentDiff, DiffUpdate, ProjectMemory } from "../types";
import TranscriptPanel from "./TranscriptPanel";

interface Props {
  diff: DocumentDiff | null;
  numberedTranscript: string;
  highlightedLines: number[];
  projectId: string;
  projectDocument: ProjectMemory;
  onConfirmed: () => void;
}

const FIELD_LABELS: Record<DiffUpdate["field"], string> = {
  overview: "项目概述",
  current_progress: "当前进度",
  key_decisions: "关键决策",
  open_issues: "待解决问题",
  next_meeting_goals: "下次会议目标",
};

function ValuePreview({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-400 italic">（空）</span>;
    return (
      <ul className="space-y-1 mt-1">
        {(value as Array<unknown>).map((item, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-gray-400 shrink-0">•</span>
            <span>
              {typeof item === "object" && item !== null && "decision" in item
                ? `[${(item as { date: string; decision: string }).date}] ${(item as { date: string; decision: string }).decision}`
                : String(item)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (!value) return <span className="text-gray-400 italic">（空）</span>;
  return <span>{String(value)}</span>;
}

export default function DiffPanel({
  diff,
  numberedTranscript,
  highlightedLines,
  projectId,
  projectDocument,
  onConfirmed,
}: Props) {
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries((diff?.updates ?? []).map((_, i) => [i, true]))
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updates = diff?.updates ?? [];

  const handleConfirm = async () => {
    const selected = updates.filter((_, i) => checked[i]);
    if (selected.length === 0) { onConfirmed(); return; }

    const newDoc = { ...projectDocument };
    for (const update of selected) {
      (newDoc as Record<string, unknown>)[update.field] = update.new;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/document`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: newDoc }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "更新失败");
      }
      setSaved(true);
      setTimeout(onConfirmed, 800);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Diff section */}
      <div className="shrink-0 border-b border-gray-200 dark:border-zinc-800 p-4 space-y-3 overflow-y-auto max-h-[55%]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
            主文档更新建议
          </span>
          {updates.length > 0 && !saved && (
            <span className="text-xs text-gray-400">{updates.filter((_, i) => checked[i]).length}/{updates.length} 条已选</span>
          )}
        </div>

        {updates.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-2">本次会议无需更新主文档</p>
        )}

        {updates.map((update, i) => (
          <div
            key={i}
            className={`rounded-lg border p-3 space-y-2 transition-colors ${
              checked[i]
                ? "border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20"
                : "border-gray-100 dark:border-zinc-800 opacity-60"
            }`}
          >
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={checked[i]}
                onChange={(e) => setChecked((prev) => ({ ...prev, [i]: e.target.checked }))}
                className="rounded border-gray-300 text-blue-600"
              />
              <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                {FIELD_LABELS[update.field] ?? update.field}
              </span>
            </label>
            <div className="pl-6 space-y-1.5 text-xs">
              <div className="text-gray-400 line-through">
                <ValuePreview value={update.old} />
              </div>
              <div className="text-gray-800 dark:text-gray-200">
                <ValuePreview value={update.new} />
              </div>
              <p className="text-gray-400 dark:text-gray-500 italic">{update.reason}</p>
            </div>
          </div>
        ))}

        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}

        <button
          onClick={handleConfirm}
          disabled={saving || saved}
          className="w-full py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saved ? "已保存 ✓" : saving ? "保存中..." : updates.length === 0 ? "返回项目" : "确认写入主文档"}
        </button>
      </div>

      {/* Transcript section */}
      <div className="flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-zinc-900">
        <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-3">原始记录</p>
        <TranscriptPanel
          numberedTranscript={numberedTranscript}
          highlightedLines={highlightedLines}
        />
      </div>
    </div>
  );
}
