"use client";

import { useState } from "react";
import { DocumentDiff, ProjectMemory } from "../types";
import TranscriptPanel from "./TranscriptPanel";

interface Props {
  diff: DocumentDiff | null;
  numberedTranscript: string;
  highlightedLines: number[];
  projectId: string;
  projectDocument: ProjectMemory;
  onConfirmed: () => void;
}

const FIELD_LABELS: Record<string, string> = {
  overview: "项目概述",
  goals: "核心目标",
  members: "成员",
  milestones: "里程碑",
  current_progress: "当前进度",
  key_decisions: "关键决策",
  open_issues: "待解决问题",
  risks: "风险",
  glossary: "术语表",
  checklist: "需求清单",
  next_meeting_goals: "下次会议目标",
};

function renderItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return String(item);
  const o = item as Record<string, unknown>;
  if ("decision" in o) return `${o.date ? `[${o.date}] ` : ""}${o.decision}${o.rationale ? ` — ${o.rationale}` : ""}`;
  if ("issue" in o) return `${o.issue}${o.owner ? ` (${o.owner})` : ""}`;
  if ("risk" in o) return `${o.risk}${o.mitigation ? ` → ${o.mitigation}` : ""}`;
  if ("item" in o && "status" in o) return `${o.status === "done" ? "✓" : "○"} ${o.item}`;
  if ("title" in o && "status" in o) return `[${o.status}] ${o.date ? `${o.date} ` : ""}${o.title}`;
  if ("name" in o && "role" in o) return `${o.name} — ${o.role}`;
  if ("term" in o) return `${o.term}: ${o.definition}`;
  return JSON.stringify(item);
}

function ValuePreview({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="text-gray-400 italic">（空）</span>;

  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if ("summary" in o)
      return <span>{o.summary as string} <span className="text-gray-400 dark:text-gray-500">截至 {o.as_of as string}</span></span>;
    const fallback = (o.summary ?? o.status ?? o.description ?? null) as string | null;
    if (fallback) return <span>{fallback}{o.as_of ? <span className="text-gray-400 dark:text-gray-500"> 截至 {o.as_of as string}</span> : null}</span>;
    return <span className="font-mono text-gray-500">{JSON.stringify(value)}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-400 italic">（空）</span>;
    return (
      <ul className="space-y-1 mt-1">
        {(value as Array<unknown>).map((item, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-gray-400 shrink-0">•</span>
            <span>{renderItem(item)}</span>
          </li>
        ))}
      </ul>
    );
  }

  return <span>{String(value)}</span>;
}

// ── Array diff helpers ────────────────────────────────────────────────────────

type ArrayDiffState = {
  unchanged: unknown[];
  deleted: unknown[];
  added: unknown[];
  deletionChecked: boolean[]; // true = restore (keep), false = accept deletion (default)
  additionChecked: boolean[]; // true = accept addition (default), false = reject
};

function computeArrayDiff(oldArr: unknown[], newArr: unknown[]): ArrayDiffState {
  const oldStrs = oldArr.map((item) => JSON.stringify(item));
  const newStrs = newArr.map((item) => JSON.stringify(item));

  const unchanged: unknown[] = [];
  const added: unknown[] = [];
  const usedOldIndices = new Set<number>();

  for (const item of newArr) {
    const str = JSON.stringify(item);
    const idx = oldStrs.findIndex((s, i) => s === str && !usedOldIndices.has(i));
    if (idx >= 0) {
      unchanged.push(item);
      usedOldIndices.add(idx);
    } else {
      added.push(item);
    }
  }

  const deleted = oldArr.filter((_, i) => !usedOldIndices.has(i));

  return {
    unchanged,
    deleted,
    added,
    deletionChecked: deleted.map(() => false),
    additionChecked: added.map(() => true),
  };
}

// ── State types ───────────────────────────────────────────────────────────────

type UpdateState = boolean | ArrayDiffState;

function isArrayDiff(s: UpdateState): s is ArrayDiffState {
  return typeof s === "object" && s !== null && "deletionChecked" in s;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DiffPanel({
  diff,
  numberedTranscript,
  highlightedLines,
  projectId,
  projectDocument,
  onConfirmed,
}: Props) {
  const updates = diff?.updates ?? [];

  const [states, setStates] = useState<Record<number, UpdateState>>(() =>
    Object.fromEntries(
      updates.map((update, i) => {
        const isArr = Array.isArray(update.new);
        if (isArr) {
          const oldArr = Array.isArray(update.old) ? (update.old as unknown[]) : [];
          const newArr = update.new as unknown[];
          return [i, computeArrayDiff(oldArr, newArr)];
        }
        return [i, true];
      })
    )
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Count: deletions accepted + additions accepted
  const { totalSelected, totalItems } = updates.reduce(
    (acc, _, i) => {
      const s = states[i];
      if (isArrayDiff(s)) {
        acc.totalItems += s.deleted.length + s.added.length;
        acc.totalSelected += s.deletionChecked.filter((v) => !v).length + s.additionChecked.filter(Boolean).length;
      } else {
        acc.totalItems += 1;
        acc.totalSelected += s ? 1 : 0;
      }
      return acc;
    },
    { totalSelected: 0, totalItems: 0 },
  );

  const handleConfirm = async () => {
    const newDoc = { ...projectDocument } as Record<string, unknown>;
    let hasChanges = false;

    updates.forEach((update, i) => {
      const s = states[i];
      if (isArrayDiff(s)) {
        const final = [
          ...s.unchanged,
          ...s.deleted.filter((_, j) => s.deletionChecked[j]),
          ...s.added.filter((_, j) => s.additionChecked[j]),
        ];
        // Only write if anything actually changed from current document
        newDoc[update.field] = final;
        hasChanges = true;
      } else if (s) {
        newDoc[update.field] = update.new;
        hasChanges = true;
      }
    });

    if (!hasChanges) { onConfirmed(); return; }

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
          {totalItems > 0 && !saved && (
            <span className="text-xs text-gray-400">{totalSelected}/{totalItems} 条变更已选</span>
          )}
        </div>

        {updates.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-2">本次会议无需更新主文档</p>
        )}

        {updates.map((update, i) => {
          const s = states[i];
          const isArr = isArrayDiff(s);

          // Determine if "nothing selected" for dim effect
          const nothingSelected = isArr
            ? s.deletionChecked.every(Boolean) && s.additionChecked.every((v) => !v)
            : !(s as boolean);

          return (
            <div
              key={i}
              className={`rounded-lg border p-3 space-y-2 transition-colors ${
                nothingSelected
                  ? "border-gray-100 dark:border-zinc-800 opacity-60"
                  : "border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20"
              }`}
            >
              {/* Field header */}
              {isArr ? (
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  {FIELD_LABELS[update.field] ?? update.field}
                </span>
              ) : (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={s as boolean}
                    onChange={(e) => setStates((prev) => ({ ...prev, [i]: e.target.checked }))}
                    className="rounded border-gray-300 text-blue-600"
                  />
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {FIELD_LABELS[update.field] ?? update.field}
                  </span>
                </label>
              )}

              <div className="pl-2 space-y-1 text-xs">
                {isArr ? (
                  <ul className="space-y-1.5">
                    {/* Unchanged: always kept, no checkbox */}
                    {(s as ArrayDiffState).unchanged.map((item, j) => (
                      <li key={`u-${j}`} className="flex items-start gap-2 pl-5">
                        <span className="text-gray-500 dark:text-gray-400 leading-relaxed">
                          {renderItem(item)}
                        </span>
                      </li>
                    ))}

                    {/* Deleted: unchecked = accept deletion (default); checked = restore */}
                    {(s as ArrayDiffState).deleted.map((item, j) => {
                      const checked = (s as ArrayDiffState).deletionChecked[j];
                      return (
                        <li key={`d-${j}`} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setStates((prev) => {
                                const cur = prev[i] as ArrayDiffState;
                                const arr = [...cur.deletionChecked];
                                arr[j] = e.target.checked;
                                return { ...prev, [i]: { ...cur, deletionChecked: arr } };
                              })
                            }
                            className="mt-0.5 rounded border-gray-300 text-blue-600 shrink-0"
                          />
                          <span className={`leading-relaxed ${checked ? "text-gray-700 dark:text-gray-300" : "line-through text-red-400 dark:text-red-500 opacity-70"}`}>
                            {renderItem(item)}
                          </span>
                          {!checked && <span className="text-red-400 dark:text-red-500 shrink-0">−</span>}
                        </li>
                      );
                    })}

                    {/* Added: checked = accept (default); unchecked = reject */}
                    {(s as ArrayDiffState).added.map((item, j) => {
                      const checked = (s as ArrayDiffState).additionChecked[j];
                      return (
                        <li key={`a-${j}`} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setStates((prev) => {
                                const cur = prev[i] as ArrayDiffState;
                                const arr = [...cur.additionChecked];
                                arr[j] = e.target.checked;
                                return { ...prev, [i]: { ...cur, additionChecked: arr } };
                              })
                            }
                            className="mt-0.5 rounded border-gray-300 text-blue-600 shrink-0"
                          />
                          <span className={`leading-relaxed ${checked ? "text-blue-700 dark:text-blue-400" : "opacity-40 line-through"}`}>
                            {renderItem(item)}
                          </span>
                          {checked && <span className="text-blue-500 dark:text-blue-400 shrink-0">+</span>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <>
                    <div className="text-gray-400 line-through pl-4">
                      <ValuePreview value={update.old} />
                    </div>
                    <div className="text-gray-800 dark:text-gray-200 pl-4">
                      <ValuePreview value={update.new} />
                    </div>
                  </>
                )}

                <p className="text-gray-400 dark:text-gray-500 italic pl-4 pt-1">{update.reason}</p>
              </div>
            </div>
          );
        })}

        {error && <p className="text-xs text-red-500">{error}</p>}

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
