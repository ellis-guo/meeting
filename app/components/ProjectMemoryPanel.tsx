"use client";

import { useState } from "react";
import { ProjectMemory } from "../types";

interface Props {
  projectId: string;
  memory: ProjectMemory;
  onUpdated: (updated: ProjectMemory) => void;
}

const FIELDS: Array<{ key: keyof ProjectMemory; label: string; isArray?: boolean }> = [
  { key: "overview", label: "项目概述" },
  { key: "current_progress", label: "当前进度" },
  { key: "key_decisions", label: "关键决策", isArray: true },
  { key: "open_issues", label: "待解决问题", isArray: true },
  { key: "next_meeting_goals", label: "下次会议目标" },
];

function ArrayDisplay({ value }: { value: unknown[] }) {
  if (!value || value.length === 0) return <span className="text-gray-400 italic text-sm">（空）</span>;
  return (
    <ul className="space-y-1">
      {value.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
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

export default function ProjectMemoryPanel({ projectId, memory, onUpdated }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProjectMemory>(memory);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/document`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存失败");
      onUpdated(draft);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(memory);
    setEditing(false);
    setError(null);
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">项目主文档</span>
          {memory.current_progress && (
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-xs">
              — {memory.current_progress}
            </span>
          )}
        </div>
        <span className={`text-gray-400 text-sm transition-transform ${expanded ? "rotate-90" : ""}`}>▶</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-gray-100 dark:border-zinc-800 px-5 py-4 space-y-4">
          {!editing ? (
            <>
              {FIELDS.map(({ key, label, isArray }) => {
                const value = memory[key];
                return (
                  <div key={key} className="space-y-1">
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</div>
                    {isArray ? (
                      <ArrayDisplay value={Array.isArray(value) ? value as unknown[] : []} />
                    ) : (
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        {value ? String(value) : <span className="text-gray-400 italic">（空）</span>}
                      </p>
                    )}
                  </div>
                );
              })}
              <button
                onClick={() => { setDraft(memory); setEditing(true); }}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                编辑主文档
              </button>
            </>
          ) : (
            <>
              {FIELDS.map(({ key, label, isArray }) => (
                <div key={key} className="space-y-1">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</label>
                  {isArray ? (
                    <textarea
                      value={
                        Array.isArray(draft[key])
                          ? (draft[key] as unknown[]).map((item) =>
                              typeof item === "object" && item !== null && "decision" in item
                                ? `[${(item as { date: string; decision: string }).date}] ${(item as { date: string; decision: string }).decision}`
                                : String(item)
                            ).join("\n")
                          : ""
                      }
                      onChange={(e) => {
                        const lines = e.target.value.split("\n").filter((l) => l.trim());
                        if (key === "key_decisions") {
                          const parsed = lines.map((line) => {
                            const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
                            return m ? { date: m[1], decision: m[2] } : { date: "", decision: line };
                          });
                          setDraft((d) => ({ ...d, key_decisions: parsed }));
                        } else {
                          setDraft((d) => ({ ...d, [key]: lines }));
                        }
                      }}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder={key === "key_decisions" ? "[YYYY-MM-DD] 决策内容（每行一条）" : "每行一条"}
                    />
                  ) : (
                    <textarea
                      value={draft[key] ? String(draft[key]) : ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value || null }))}
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}
                </div>
              ))}
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
                <button
                  onClick={handleCancel}
                  className="px-4 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
