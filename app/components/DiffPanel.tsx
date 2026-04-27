"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DocumentDiff, ProjectMemory } from "../types";
import TranscriptPanel from "./TranscriptPanel";

interface Props {
  diff: DocumentDiff | null;
  numberedTranscript: string;
  highlightedLines: number[];
  projectId: string;
  projectDocument: ProjectMemory;
  meetingDate: string;
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

const FULL_LISTING_FIELDS = new Set(["checklist", "milestones", "open_issues", "next_meeting_goals"]);

// ── Types ─────────────────────────────────────────────────────────────────────

type ChecklistItemState = { item: string; status: "done" | "pending" };
type MilestoneItemState = { date: string | null; title: string; status: "done" | "pending" };
type OpenIssueState = {
  issue: string; owner: string | null;
  opened_at: string | null; resolved_at: string | null;
  isNew: boolean; willResolve: boolean; accepted: boolean;
};
type NextGoalState = {
  goal: string; set_at: string | null; completed_at: string | null;
  isNew: boolean; willComplete: boolean; accepted: boolean;
};

// ── Normalize helpers ─────────────────────────────────────────────────────────

function normalizeOpenIssue(item: unknown) {
  if (typeof item === "string") return { issue: item, owner: null, opened_at: null, resolved_at: null };
  const o = item as Record<string, unknown>;
  return {
    issue: String(o.issue ?? ""),
    owner: (o.owner as string | null) ?? null,
    opened_at: (o.opened_at as string | null) ?? null,
    resolved_at: (o.resolved_at as string | null) ?? null,
  };
}

function normalizeNextGoal(item: unknown) {
  if (typeof item === "string") return { goal: item, set_at: null, completed_at: null };
  const o = item as Record<string, unknown>;
  return {
    goal: String(o.goal ?? ""),
    set_at: (o.set_at as string | null) ?? null,
    completed_at: (o.completed_at as string | null) ?? null,
  };
}

// ── Standard diff helpers ─────────────────────────────────────────────────────

function renderItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return String(item);
  const o = item as Record<string, unknown>;
  if ("decision" in o) return `${o.date ? `[${o.date}] ` : ""}${o.decision}${o.rationale ? ` — ${o.rationale}` : ""}`;
  if ("issue" in o) return `${o.issue}${o.owner ? ` (${o.owner})` : ""}${o.resolved_at ? ` ✓ ${o.resolved_at}` : ""}`;
  if ("goal" in o) return `${o.goal}${o.completed_at ? ` ✓ ${o.completed_at}` : ""}`;
  if ("summary" in o) return `${o.summary} (截至 ${o.as_of})`;
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
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-400 italic">（空）</span>;
    return (
      <ul className="space-y-1 mt-1">
        {(value as unknown[]).map((item, i) => (
          <li key={i} className="flex gap-1.5"><span className="text-gray-400 shrink-0">•</span><span>{renderItem(item)}</span></li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("summary" in o) return <span>{o.summary as string} <span className="text-gray-400 dark:text-gray-500">截至 {o.as_of as string}</span></span>;
    return <span className="font-mono text-gray-500">{JSON.stringify(value)}</span>;
  }
  return <span>{String(value)}</span>;
}

type ArrayDiffState = {
  unchanged: unknown[]; deleted: unknown[]; added: unknown[];
  deletionChecked: boolean[]; additionChecked: boolean[];
};

function computeArrayDiff(oldArr: unknown[], newArr: unknown[]): ArrayDiffState {
  const oldStrs = oldArr.map(i => JSON.stringify(i));
  const unchanged: unknown[] = [], added: unknown[] = [];
  const used = new Set<number>();
  for (const item of newArr) {
    const str = JSON.stringify(item);
    const idx = oldStrs.findIndex((s, i) => s === str && !used.has(i));
    if (idx >= 0) { unchanged.push(item); used.add(idx); } else { added.push(item); }
  }
  const deleted = oldArr.filter((_, i) => !used.has(i));
  return { unchanged, deleted, added, deletionChecked: deleted.map(() => false), additionChecked: added.map(() => true) };
}

type UpdateState = boolean | ArrayDiffState;
function isArrayDiff(s: UpdateState): s is ArrayDiffState {
  return typeof s === "object" && s !== null && "deletionChecked" in s;
}

// ── Full-listing state initializers ───────────────────────────────────────────

function initChecklist(doc: ProjectMemory, updates: DocumentDiff["updates"]): ChecklistItemState[] {
  const llm = updates.find(u => u.field === "checklist");
  if (llm && Array.isArray(llm.new))
    return (llm.new as ChecklistItemState[]).map(i => ({ item: String((i as Record<string,unknown>).item ?? ""), status: ((i as Record<string,unknown>).status as "done" | "pending") ?? "pending" }));
  return (Array.isArray(doc.checklist) ? doc.checklist : [])
    .map(i => ({ item: String((i as Record<string,unknown>).item ?? ""), status: ((i as Record<string,unknown>).status as "done" | "pending") ?? "pending" }));
}

function initMilestones(doc: ProjectMemory, updates: DocumentDiff["updates"]): MilestoneItemState[] {
  const llm = updates.find(u => u.field === "milestones");
  if (llm && Array.isArray(llm.new))
    return (llm.new as MilestoneItemState[]).map(i => ({ date: ((i as Record<string,unknown>).date as string | null) ?? null, title: String((i as Record<string,unknown>).title ?? ""), status: ((i as Record<string,unknown>).status as "done" | "pending") ?? "pending" }));
  return (Array.isArray(doc.milestones) ? doc.milestones : [])
    .map(i => ({ date: ((i as Record<string,unknown>).date as string | null) ?? null, title: String((i as Record<string,unknown>).title ?? ""), status: ((i as Record<string,unknown>).status as "done" | "pending") ?? "pending" }));
}

function initOpenIssues(doc: ProjectMemory, updates: DocumentDiff["updates"]): OpenIssueState[] {
  const existing = (Array.isArray(doc.open_issues) ? doc.open_issues : []).map(normalizeOpenIssue);
  const llm = updates.find(u => u.field === "open_issues");
  if (!llm || !Array.isArray(llm.new)) {
    return existing.filter(i => !i.resolved_at).map(i => ({ ...i, isNew: false, willResolve: false, accepted: true }));
  }
  const llmNew = (llm.new as unknown[]).map(normalizeOpenIssue);
  const existingSet = new Set(existing.map(i => i.issue));
  const addedByLLM = llmNew.filter(i => !existingSet.has(i.issue));
  const resolvedByLLM = new Set(llmNew.filter(i => i.resolved_at && existingSet.has(i.issue)).map(i => i.issue));
  return [
    ...existing.filter(i => !i.resolved_at).map(i => ({ ...i, isNew: false, willResolve: resolvedByLLM.has(i.issue), accepted: true })),
    ...addedByLLM.map(i => ({ ...i, isNew: true, willResolve: false, accepted: true })),
  ];
}

function initNextGoals(doc: ProjectMemory, updates: DocumentDiff["updates"]): NextGoalState[] {
  const rawExisting = Array.isArray(doc.next_meeting_goals) ? doc.next_meeting_goals
    : typeof doc.next_meeting_goals === "string" ? [{ goal: doc.next_meeting_goals, set_at: null, completed_at: null }] : [];
  const existing = rawExisting.map(normalizeNextGoal);
  const llm = updates.find(u => u.field === "next_meeting_goals");
  if (!llm || !Array.isArray(llm.new)) {
    return existing.filter(i => !i.completed_at).map(i => ({ ...i, isNew: false, willComplete: false, accepted: true }));
  }
  const llmNew = (llm.new as unknown[]).map(normalizeNextGoal);
  const existingSet = new Set(existing.map(i => i.goal));
  const addedByLLM = llmNew.filter(i => !existingSet.has(i.goal));
  const completedByLLM = new Set(llmNew.filter(i => i.completed_at && existingSet.has(i.goal)).map(i => i.goal));
  return [
    ...existing.filter(i => !i.completed_at).map(i => ({ ...i, isNew: false, willComplete: completedByLLM.has(i.goal), accepted: true })),
    ...addedByLLM.map(i => ({ ...i, isNew: true, willComplete: false, accepted: true })),
  ];
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DiffPanel({ diff, numberedTranscript, highlightedLines, projectId, projectDocument, meetingDate, onConfirmed }: Props) {
  const allUpdates = diff?.updates ?? [];
  const stdUpdates = allUpdates.filter(u => !FULL_LISTING_FIELDS.has(u.field));

  const [states, setStates] = useState<Record<number, UpdateState>>(() =>
    Object.fromEntries(stdUpdates.map((u, i) => {
      if (Array.isArray(u.new)) return [i, computeArrayDiff(Array.isArray(u.old) ? (u.old as unknown[]) : [], u.new as unknown[])];
      return [i, true];
    }))
  );

  const [checklistState, setChecklistState] = useState<ChecklistItemState[]>(() => initChecklist(projectDocument, allUpdates));
  const [milestonesState, setMilestonesState] = useState<MilestoneItemState[]>(() => initMilestones(projectDocument, allUpdates));
  const [openIssuesState, setOpenIssuesState] = useState<OpenIssueState[]>(() => initOpenIssues(projectDocument, allUpdates));
  const [nextGoalsState, setNextGoalsState] = useState<NextGoalState[]>(() => initNextGoals(projectDocument, allUpdates));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    const newDoc = { ...projectDocument } as Record<string, unknown>;

    // Standard updates
    stdUpdates.forEach((u, i) => {
      const s = states[i];
      if (isArrayDiff(s)) {
        newDoc[u.field] = [...s.unchanged, ...s.deleted.filter((_, j) => s.deletionChecked[j]), ...s.added.filter((_, j) => s.additionChecked[j])];
      } else if (s) {
        newDoc[u.field] = u.new;
      }
    });

    // Checklist
    newDoc.checklist = checklistState;

    // Milestones
    newDoc.milestones = milestonesState;

    // Open issues: keep archived resolved + apply user selections
    const archivedResolved = (Array.isArray(projectDocument.open_issues) ? projectDocument.open_issues : [])
      .map(normalizeOpenIssue).filter(i => !!i.resolved_at);
    newDoc.open_issues = [
      ...archivedResolved,
      ...openIssuesState.filter(i => !i.isNew).map(({ isNew: _, willResolve, accepted: __, ...rest }) =>
        willResolve ? { ...rest, resolved_at: meetingDate } : rest),
      ...openIssuesState.filter(i => i.isNew && i.accepted).map(i => ({ issue: i.issue, owner: i.owner, opened_at: meetingDate, resolved_at: null })),
    ];

    // Next meeting goals: keep completed + apply user selections
    const archivedCompleted = (Array.isArray(projectDocument.next_meeting_goals)
      ? projectDocument.next_meeting_goals
      : typeof projectDocument.next_meeting_goals === "string"
        ? [{ goal: projectDocument.next_meeting_goals, set_at: null, completed_at: null }]
        : []).map(normalizeNextGoal).filter(i => !!i.completed_at);
    const newGoals = [
      ...archivedCompleted,
      ...nextGoalsState.filter(i => !i.isNew).map(({ isNew: _, willComplete, accepted: __, ...rest }) =>
        willComplete ? { ...rest, completed_at: meetingDate } : rest),
      ...nextGoalsState.filter(i => i.isNew && i.accepted).map(i => ({ goal: i.goal, set_at: meetingDate, completed_at: null })),
    ];
    newDoc.next_meeting_goals = newGoals.length > 0 ? newGoals : null;

    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/document`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: newDoc }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "更新失败"); }
      toast.success("主文档已更新");
      setTimeout(onConfirmed, 500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const hasContent = stdUpdates.length > 0 || checklistState.length > 0 || milestonesState.length > 0 || openIssuesState.length > 0 || nextGoalsState.length > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 border-b border-gray-200 dark:border-zinc-800 p-4 space-y-3 overflow-y-auto max-h-[60%]">
        <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">主文档更新建议</span>

        {!hasContent && <p className="text-sm text-gray-500 dark:text-gray-400 py-2">本次会议无需更新主文档</p>}

        {/* Standard LLM updates (non-full-listing fields) */}
        {stdUpdates.map((update, i) => {
          const s = states[i];
          const isArr = isArrayDiff(s);
          const nothingSelected = isArr ? s.deletionChecked.every(Boolean) && s.additionChecked.every(v => !v) : !(s as boolean);
          return (
            <div key={i} className={`rounded-lg border p-3 space-y-2 transition-colors ${nothingSelected ? "border-gray-100 dark:border-zinc-800 opacity-60" : "border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20"}`}>
              {isArr ? (
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{FIELD_LABELS[update.field] ?? update.field}</span>
              ) : (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={s as boolean} onChange={e => setStates(p => ({ ...p, [i]: e.target.checked }))} className="rounded border-gray-300 text-blue-600" />
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{FIELD_LABELS[update.field] ?? update.field}</span>
                </label>
              )}
              <div className="pl-2 space-y-1 text-xs">
                {isArr ? (
                  <ul className="space-y-1.5">
                    {(s as ArrayDiffState).unchanged.map((item, j) => <li key={`u-${j}`} className="pl-5 text-gray-500 dark:text-gray-400 leading-relaxed">{renderItem(item)}</li>)}
                    {(s as ArrayDiffState).deleted.map((item, j) => {
                      const checked = (s as ArrayDiffState).deletionChecked[j];
                      return (
                        <li key={`d-${j}`} className="flex items-start gap-2">
                          <input type="checkbox" checked={checked} onChange={e => setStates(p => { const c = p[i] as ArrayDiffState; const a = [...c.deletionChecked]; a[j] = e.target.checked; return { ...p, [i]: { ...c, deletionChecked: a } }; })} className="mt-0.5 rounded border-gray-300 text-blue-600 shrink-0" />
                          <span className={`leading-relaxed ${checked ? "text-gray-700 dark:text-gray-300" : "line-through text-red-400 opacity-70"}`}>{renderItem(item)}</span>
                          {!checked && <span className="text-red-400 shrink-0">−</span>}
                        </li>
                      );
                    })}
                    {(s as ArrayDiffState).added.map((item, j) => {
                      const checked = (s as ArrayDiffState).additionChecked[j];
                      return (
                        <li key={`a-${j}`} className="flex items-start gap-2">
                          <input type="checkbox" checked={checked} onChange={e => setStates(p => { const c = p[i] as ArrayDiffState; const a = [...c.additionChecked]; a[j] = e.target.checked; return { ...p, [i]: { ...c, additionChecked: a } }; })} className="mt-0.5 rounded border-gray-300 text-blue-600 shrink-0" />
                          <span className={`leading-relaxed ${checked ? "text-blue-700 dark:text-blue-400" : "opacity-40 line-through"}`}>{renderItem(item)}</span>
                          {checked && <span className="text-blue-500 shrink-0">+</span>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <>
                    <div className="text-gray-400 line-through pl-4"><ValuePreview value={update.old} /></div>
                    <div className="text-gray-800 dark:text-gray-200 pl-4"><ValuePreview value={update.new} /></div>
                  </>
                )}
                <p className="text-gray-400 dark:text-gray-500 italic pl-4 pt-1">{update.reason}</p>
              </div>
            </div>
          );
        })}

        {/* Full listing: Checklist */}
        {checklistState.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-zinc-700 p-3 space-y-2">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">需求清单</span>
            <ul className="space-y-1.5">
              {checklistState.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={item.status === "done"}
                    onChange={e => setChecklistState(p => p.map((c, j) => j === i ? { ...c, status: e.target.checked ? "done" : "pending" } : c))}
                    className="rounded border-gray-300 text-blue-600 shrink-0" />
                  <span className={item.status === "done" ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}>{item.item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Full listing: Milestones */}
        {milestonesState.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-zinc-700 p-3 space-y-2">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">里程碑</span>
            <ul className="space-y-1.5">
              {milestonesState.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={item.status === "done"}
                    onChange={e => setMilestonesState(p => p.map((m, j) => j === i ? { ...m, status: e.target.checked ? "done" : "pending" } : m))}
                    className="rounded border-gray-300 text-blue-600 shrink-0" />
                  <span className={item.status === "done" ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}>
                    {item.date && <span className="text-gray-400 mr-1.5">{item.date}</span>}
                    {item.title}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Full listing: Open Issues */}
        {openIssuesState.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-zinc-700 p-3 space-y-2">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">待解决问题</span>
            <ul className="space-y-1.5">
              {openIssuesState.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <input type="checkbox"
                    checked={item.isNew ? item.accepted : item.willResolve}
                    onChange={e => setOpenIssuesState(p => p.map((o, j) => j === i
                      ? item.isNew ? { ...o, accepted: e.target.checked } : { ...o, willResolve: e.target.checked }
                      : o))}
                    className="mt-0.5 rounded border-gray-300 text-blue-600 shrink-0" />
                  <span className={`leading-relaxed flex-1 ${item.isNew ? "text-blue-700 dark:text-blue-400" : item.willResolve ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}`}>
                    {item.isNew && <span className="text-blue-500 mr-1 not-italic">+</span>}
                    {item.issue}
                    {item.owner && <span className="text-gray-400 ml-1">({item.owner})</span>}
                  </span>
                  {!item.isNew && (
                    <span className="text-gray-400 shrink-0">{item.willResolve ? `✓ ${meetingDate}` : item.opened_at ?? ""}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Full listing: Next Meeting Goals */}
        {nextGoalsState.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-zinc-700 p-3 space-y-2">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">下次会议目标</span>
            <ul className="space-y-1.5">
              {nextGoalsState.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <input type="checkbox"
                    checked={item.isNew ? item.accepted : item.willComplete}
                    onChange={e => setNextGoalsState(p => p.map((g, j) => j === i
                      ? item.isNew ? { ...g, accepted: e.target.checked } : { ...g, willComplete: e.target.checked }
                      : g))}
                    className="mt-0.5 rounded border-gray-300 text-blue-600 shrink-0" />
                  <span className={`leading-relaxed flex-1 ${item.isNew ? "text-blue-700 dark:text-blue-400" : item.willComplete ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}`}>
                    {item.isNew && <span className="text-blue-500 mr-1">+</span>}
                    {item.goal}
                  </span>
                  {!item.isNew && item.set_at && (
                    <span className="text-gray-400 shrink-0">{item.willComplete ? `✓ ${meetingDate}` : item.set_at}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        <button onClick={handleConfirm} disabled={saving}
          className="w-full py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {saving ? "保存中..." : !hasContent ? "返回项目" : "确认写入主文档"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-zinc-900">
        <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-3">原始记录</p>
        <TranscriptPanel numberedTranscript={numberedTranscript} highlightedLines={highlightedLines} />
      </div>
    </div>
  );
}
