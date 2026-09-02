"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DocumentDiff, ProjectMemory } from "../types";

interface Props {
  diff: DocumentDiff | null;
  projectId: string;
  meetingId?: string;            // 新建会议流程下可能为空（meeting 还没 create）
  projectDocument: ProjectMemory;
  meetingDate: string;
  onConfirmed: () => void;
  onDismissed?: () => void;      // 可选：忽略本次更新
}

const FIELD_LABELS: Record<string, string> = {
  overview: "项目概述",
  goals: "核心目标",
  members: "成员",
  milestones: "里程碑",
  key_decisions: "关键决策",
  open_issues: "待解决问题",
  risks: "风险",
  glossary: "术语表",
  checklist: "需求清单",
};

const FULL_LISTING_FIELDS = new Set(["checklist", "milestones", "open_issues"]);

// ── Types ─────────────────────────────────────────────────────────────────────

type ChecklistItemState = { item: string; status: "done" | "pending" };
type MilestoneItemState = { date: string | null; title: string; status: "done" | "pending" };
type OpenIssueState = {
  issue: string; owner: string | null;
  opened_at: string | null; resolved_at: string | null;
  isNew: boolean; willResolve: boolean; accepted: boolean;
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

// ── Standard diff helpers ─────────────────────────────────────────────────────

function renderItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return String(item);
  const o = item as Record<string, unknown>;
  if ("decision" in o) return `${o.date ? `[${o.date}] ` : ""}${o.decision}${o.rationale ? ` — ${o.rationale}` : ""}`;
  if ("issue" in o) return `${o.issue}${o.owner ? ` (${o.owner})` : ""}${o.resolved_at ? ` ✓ ${o.resolved_at}` : ""}`;
  if ("risk" in o) return `${o.risk}${o.mitigation ? ` → ${o.mitigation}` : ""}`;
  if ("item" in o && "status" in o) return `${o.status === "done" ? "✓" : "○"} ${o.item}`;
  if ("title" in o && "status" in o) return `[${o.status}] ${o.date ? `${o.date} ` : ""}${o.title}`;
  if ("name" in o && "role" in o) return `${o.name} — ${o.role}`;
  if ("term" in o) return `${o.term}: ${o.definition}`;
  return JSON.stringify(item);
}

function ValuePreview({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="text-lark-4 italic">（空）</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-lark-4 italic">（空）</span>;
    return (
      <ul className="space-y-1 mt-1">
        {(value as unknown[]).map((item, i) => (
          <li key={i} className="flex gap-1.5"><span className="text-lark-3 shrink-0">•</span><span>{renderItem(item)}</span></li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    return <span className="font-mono text-lark-3">{JSON.stringify(value)}</span>;
  }
  return <span>{String(value)}</span>;
}

type ArrayDiffState = {
  unchanged: unknown[]; deleted: unknown[]; added: unknown[];
  deletionChecked: boolean[]; additionChecked: boolean[];
};

// 勾选语义：checked = 该条目出现在新文档里。
// deleted 组默认不勾（= 接受 AI 的删除建议），added 组默认勾上（= 接受新增建议）。
// lockDeletions 用于 key_decisions —— 后端强制“只增不删”，UI 里就不该让用户勾出一个
// 必然被 400 拒绝的状态。
function computeArrayDiff(oldArr: unknown[], newArr: unknown[], lockDeletions = false): ArrayDiffState {
  const oldStrs = oldArr.map(i => JSON.stringify(i));
  const unchanged: unknown[] = [], added: unknown[] = [];
  const used = new Set<number>();
  for (const item of newArr) {
    const str = JSON.stringify(item);
    const idx = oldStrs.findIndex((s, i) => s === str && !used.has(i));
    if (idx >= 0) { unchanged.push(item); used.add(idx); } else { added.push(item); }
  }
  const deleted = oldArr.filter((_, i) => !used.has(i));
  return {
    unchanged,
    deleted,
    added,
    deletionChecked: deleted.map(() => lockDeletions),
    additionChecked: added.map(() => true),
  };
}

// 只增不删的字段，与后端 diff/apply + PATCH /document 的校验保持一致
const APPEND_ONLY_FIELDS = new Set(["key_decisions"]);

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

// ── Main component ─────────────────────────────────────────────────────────────

export default function DiffPanel({ diff, projectId, meetingId, projectDocument, meetingDate, onConfirmed, onDismissed }: Props) {
  const allUpdates = diff?.updates ?? [];
  const stdUpdates = allUpdates.filter(u => !FULL_LISTING_FIELDS.has(u.field));

  const [states, setStates] = useState<Record<number, UpdateState>>(() =>
    Object.fromEntries(stdUpdates.map((u, i) => {
      if (Array.isArray(u.new)) {
        return [i, computeArrayDiff(
          Array.isArray(u.old) ? (u.old as unknown[]) : [],
          u.new as unknown[],
          APPEND_ONLY_FIELDS.has(u.field),
        )];
      }
      return [i, true];
    }))
  );

  const [checklistState, setChecklistState] = useState<ChecklistItemState[]>(() => initChecklist(projectDocument, allUpdates));
  const [milestonesState, setMilestonesState] = useState<MilestoneItemState[]>(() => initMilestones(projectDocument, allUpdates));
  const [openIssuesState, setOpenIssuesState] = useState<OpenIssueState[]>(() => initOpenIssues(projectDocument, allUpdates));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    const newDoc = { ...projectDocument } as Record<string, unknown>;

    stdUpdates.forEach((u, i) => {
      const s = states[i];
      if (isArrayDiff(s)) {
        newDoc[u.field] = [...s.unchanged, ...s.deleted.filter((_, j) => s.deletionChecked[j]), ...s.added.filter((_, j) => s.additionChecked[j])];
      } else if (s) {
        newDoc[u.field] = u.new;
      }
    });

    newDoc.checklist = checklistState;
    newDoc.milestones = milestonesState;

    const archivedResolved = (Array.isArray(projectDocument.open_issues) ? projectDocument.open_issues : [])
      .map(normalizeOpenIssue).filter(i => !!i.resolved_at);
    newDoc.open_issues = [
      ...archivedResolved,
      // 落库时剥掉三个纯 UI 字段（isNew / willResolve / accepted）
      ...openIssuesState.filter(i => !i.isNew).map((i) => ({
        issue: i.issue,
        owner: i.owner,
        opened_at: i.opened_at,
        resolved_at: i.willResolve ? meetingDate : i.resolved_at,
      })),
      ...openIssuesState.filter(i => i.isNew && i.accepted).map(i => ({ issue: i.issue, owner: i.owner, opened_at: meetingDate, resolved_at: null })),
    ];

    setSaving(true); setError(null);
    try {
      // 有 meetingId 时走 apply 接口（同时标记 diff_status=confirmed 并清空 document_diff）
      // 没有 meetingId（新建流程内 meeting 已存在但未传时）回退到旧的 PATCH /document
      const url = meetingId
        ? `/api/projects/${projectId}/meetings/${meetingId}/diff/apply`
        : `/api/projects/${projectId}/document`;
      const res = await fetch(url, {
        method: meetingId ? "POST" : "PATCH",
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

  const handleDismiss = async () => {
    if (!meetingId || !onDismissed) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/meetings/${meetingId}/diff/dismiss`, { method: "POST" });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "忽略失败"); }
      toast.success("已忽略本次主文档更新");
      onDismissed();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const hasContent = stdUpdates.length > 0 || checklistState.length > 0 || milestonesState.length > 0 || openIssuesState.length > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 p-4 space-y-3 overflow-y-auto">
        {!hasContent && <p className="text-sm text-lark-2 py-2">本次会议无需更新主文档</p>}

        {/* Standard LLM updates */}
        {stdUpdates.map((update, i) => {
          const s = states[i];
          const isArr = isArrayDiff(s);
          const appendOnly = APPEND_ONLY_FIELDS.has(update.field);
          const nothingSelected = isArr ? s.deletionChecked.every(Boolean) && s.additionChecked.every(v => !v) : !(s as boolean);
          return (
            <div key={i} className={`rounded-lg border p-3 space-y-2 transition-colors ${nothingSelected ? "border-lark-border opacity-60" : "border-lark-blue/30 bg-lark-blue-light/50"}`}>
              {isArr ? (
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-lark-1">{FIELD_LABELS[update.field] ?? update.field}</span>
                  <span className="text-[10px] text-lark-3">勾选 = 写入新文档；划线条目将被移除</span>
                  {appendOnly && (
                    <span className="text-[10px] text-lark-3">· 该字段只增不删，已有条目已锁定</span>
                  )}
                </div>
              ) : (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={s as boolean} onChange={e => setStates(p => ({ ...p, [i]: e.target.checked }))} className="rounded border-lark-border accent-lark-blue" />
                  <span className="text-xs font-semibold text-lark-1">{FIELD_LABELS[update.field] ?? update.field}</span>
                </label>
              )}
              <div className="pl-2 space-y-1 text-xs">
                {isArr ? (
                  <ul className="space-y-1.5">
                    {(s as ArrayDiffState).unchanged.map((item, j) => <li key={`u-${j}`} className="pl-5 text-lark-3 leading-relaxed">{renderItem(item)}</li>)}
                    {(s as ArrayDiffState).deleted.map((item, j) => {
                      const checked = (s as ArrayDiffState).deletionChecked[j];
                      return (
                        <li key={`d-${j}`} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={appendOnly}
                            title={appendOnly ? "关键决策只能新增，不能删除" : undefined}
                            onChange={e => setStates(p => { const c = p[i] as ArrayDiffState; const a = [...c.deletionChecked]; a[j] = e.target.checked; return { ...p, [i]: { ...c, deletionChecked: a } }; })}
                            className="mt-0.5 rounded border-lark-border accent-lark-blue shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
                          />
                          <span className={`leading-relaxed ${checked ? "text-lark-1" : "line-through text-lark-danger opacity-70"}`}>{renderItem(item)}</span>
                          {!checked && <span className="text-lark-danger shrink-0">−</span>}
                        </li>
                      );
                    })}
                    {(s as ArrayDiffState).added.map((item, j) => {
                      const checked = (s as ArrayDiffState).additionChecked[j];
                      return (
                        <li key={`a-${j}`} className="flex items-start gap-2">
                          <input type="checkbox" checked={checked} onChange={e => setStates(p => { const c = p[i] as ArrayDiffState; const a = [...c.additionChecked]; a[j] = e.target.checked; return { ...p, [i]: { ...c, additionChecked: a } }; })} className="mt-0.5 rounded border-lark-border accent-lark-blue shrink-0" />
                          <span className={`leading-relaxed ${checked ? "text-lark-blue" : "opacity-40 line-through"}`}>{renderItem(item)}</span>
                          {checked && <span className="text-lark-blue shrink-0">+</span>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <>
                    <div className="text-lark-3 line-through pl-4"><ValuePreview value={update.old} /></div>
                    <div className="text-lark-1 pl-4"><ValuePreview value={update.new} /></div>
                  </>
                )}
                <p className="text-lark-3 italic pl-4 pt-1">{update.reason}</p>
              </div>
            </div>
          );
        })}

        {/* Full listing: Checklist */}
        {checklistState.length > 0 && (
          <div className="rounded-lg border border-lark-border p-3 space-y-2">
            <span className="text-xs font-semibold text-lark-1">需求清单</span>
            <ul className="space-y-1.5">
              {checklistState.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={item.status === "done"}
                    onChange={e => setChecklistState(p => p.map((c, j) => j === i ? { ...c, status: e.target.checked ? "done" : "pending" } : c))}
                    className="rounded border-lark-border accent-lark-blue shrink-0" />
                  <span className={item.status === "done" ? "line-through text-lark-3" : "text-lark-1"}>{item.item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Full listing: Milestones */}
        {milestonesState.length > 0 && (
          <div className="rounded-lg border border-lark-border p-3 space-y-2">
            <span className="text-xs font-semibold text-lark-1">里程碑</span>
            <ul className="space-y-1.5">
              {milestonesState.map((item, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={item.status === "done"}
                    onChange={e => setMilestonesState(p => p.map((m, j) => j === i ? { ...m, status: e.target.checked ? "done" : "pending" } : m))}
                    className="rounded border-lark-border accent-lark-blue shrink-0" />
                  <span className={item.status === "done" ? "line-through text-lark-3" : "text-lark-1"}>
                    {item.date && <span className="text-lark-3 mr-1.5">{item.date}</span>}
                    {item.title}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Full listing: Open Issues */}
        {openIssuesState.length > 0 && (
          <div className="rounded-lg border border-lark-border p-3 space-y-2">
            <span className="text-xs font-semibold text-lark-1">待解决问题</span>
            <ul className="space-y-1.5">
              {openIssuesState.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <input type="checkbox"
                    checked={item.isNew ? item.accepted : item.willResolve}
                    onChange={e => setOpenIssuesState(p => p.map((o, j) => j === i
                      ? item.isNew ? { ...o, accepted: e.target.checked } : { ...o, willResolve: e.target.checked }
                      : o))}
                    className="mt-0.5 rounded border-lark-border accent-lark-blue shrink-0" />
                  <span className={`leading-relaxed flex-1 ${item.isNew ? "text-lark-blue" : item.willResolve ? "line-through text-lark-3" : "text-lark-1"}`}>
                    {item.isNew && <span className="text-lark-blue mr-1 not-italic">+</span>}
                    {item.issue}
                    {item.owner && <span className="text-lark-3 ml-1">({item.owner})</span>}
                  </span>
                  {!item.isNew && (
                    <span className="text-lark-3 shrink-0">{item.willResolve ? `✓ ${meetingDate}` : item.opened_at ?? ""}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="text-xs text-lark-danger">{error}</p>}

        <div className="flex gap-2">
          <button onClick={handleConfirm} disabled={saving}
            className="flex-1 py-2 text-sm font-medium rounded-lg bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {saving ? "保存中..." : !hasContent ? "返回项目" : "确认写入主文档"}
          </button>
          {meetingId && onDismissed && hasContent && (
            <button onClick={handleDismiss} disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-lark-border text-lark-2 hover:bg-lark-sunken disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              忽略
            </button>
          )}
        </div>
      </div>

    </div>
  );
}
