"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { ProjectMemory } from "../types";

interface Props {
  projectId: string;
  memory: ProjectMemory;
  onUpdated: (updated: ProjectMemory) => void;
  initialExpanded?: boolean;
}

const KNOWN_LABELS: Record<string, string> = {
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

const FIELD_ORDER = [
  "overview", "goals", "members", "milestones", "current_progress",
  "key_decisions", "open_issues", "risks", "glossary", "checklist", "next_meeting_goals",
];

function renderItem(item: unknown): { icon: string | null; text: string; strikethrough?: boolean; meta?: string } {
  if (typeof item === "string") return { icon: null, text: item };
  if (typeof item !== "object" || item === null) return { icon: null, text: String(item) };
  const o = item as Record<string, unknown>;
  if ("decision" in o) return { icon: null, text: `${o.date ? `[${o.date}] ` : ""}${o.decision}${o.rationale ? ` — ${o.rationale}` : ""}` };
  if ("issue" in o) {
    const resolved = o.resolved_at as string | null;
    return {
      icon: resolved ? "✓" : "○",
      text: `${o.issue}${o.owner ? ` (${o.owner})` : ""}`,
      strikethrough: !!resolved,
      meta: resolved ? `已解决 ${resolved}` : (o.opened_at ? `${o.opened_at}` : undefined),
    };
  }
  if ("goal" in o) {
    const completed = o.completed_at as string | null;
    return {
      icon: completed ? "✓" : "○",
      text: String(o.goal),
      strikethrough: !!completed,
      meta: completed ? `已完成 ${completed}` : (o.set_at ? `${o.set_at}` : undefined),
    };
  }
  if ("summary" in o) return { icon: null, text: String(o.summary), meta: o.as_of ? `截至 ${o.as_of}` : undefined };
  if ("risk" in o) return { icon: null, text: `${o.risk}${o.mitigation ? ` → ${o.mitigation}` : ""}` };
  if ("name" in o && "role" in o) return { icon: null, text: `${o.name} — ${o.role}` };
  if ("term" in o) return { icon: null, text: `${o.term}: ${o.definition}` };
  if ("item" in o && "status" in o) return { icon: o.status === "done" ? "✓" : "○", text: String(o.item) };
  if ("title" in o && "status" in o) return { icon: o.status === "done" ? "✓" : "○", text: `${o.date ? `${o.date}  ` : ""}${o.title}` };
  return { icon: null, text: JSON.stringify(item) };
}

function FieldValue({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-lark-4 italic text-sm">（空）</span>;

  if (typeof value === "string")
    return <p className="text-sm text-lark-1">{value}</p>;

  if (Array.isArray(value)) {
    if (value.length === 0)
      return <span className="text-lark-4 italic text-sm">（空）</span>;

    if (fieldKey === "current_progress") {
      const entries = value as Array<{ summary: string; as_of: string }>;
      const latest = entries[entries.length - 1];
      const history = entries.slice(0, -1).reverse();
      return (
        <div className="space-y-1">
          <p className="text-sm text-lark-1">
            {latest.summary}{" "}
            <span className="text-lark-3 text-xs">截至 {latest.as_of}</span>
          </p>
          {history.length > 0 && (
            <details className="text-xs text-lark-3">
              <summary className="cursor-pointer hover:text-lark-2">历史记录 ({history.length})</summary>
              <ul className="mt-1 space-y-0.5 pl-2 border-l border-lark-border">
                {history.map((e, i) => (
                  <li key={i}>{e.summary} <span className="opacity-60">截至 {e.as_of}</span></li>
                ))}
              </ul>
            </details>
          )}
        </div>
      );
    }

    return (
      <ul className="space-y-1">
        {value.map((item, i) => {
          const rendered = renderItem(item);
          return (
            <li key={i} className={`flex gap-2 text-sm ${rendered.strikethrough ? "text-lark-3" : "text-lark-1"}`}>
              <span className="text-lark-3 shrink-0">{rendered.icon ?? "•"}</span>
              <span className={rendered.strikethrough ? "line-through" : ""}>{rendered.text}</span>
              {rendered.meta && <span className="text-xs text-lark-3 shrink-0 self-center">{rendered.meta}</span>}
            </li>
          );
        })}
      </ul>
    );
  }

  if (typeof value === "object")
    return <p className="text-sm font-mono text-lark-2">{JSON.stringify(value)}</p>;

  return <p className="text-sm text-lark-1">{String(value)}</p>;
}

function sortedKeys(memory: ProjectMemory): string[] {
  const keys = Object.keys(memory);
  const known = FIELD_ORDER.filter((k) => keys.includes(k));
  const custom = keys.filter((k) => !FIELD_ORDER.includes(k));
  return [...known, ...custom];
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export default function ProjectMemoryPanel({ projectId, memory, onUpdated, initialExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [editing, setEditing] = useState(false);
  const [draftJson, setDraftJson] = useState("");
  const [newSectionKey, setNewSectionKey] = useState("");
  const [addingSection, setAddingSection] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleStartEdit = () => {
    setDraftJson(JSON.stringify(memory, null, 2));
    setJsonError(null);
    setSaveError(null);
    setAddingSection(false);
    setNewSectionKey("");
    setEditing(true);
  };

  const handleAddSection = () => {
    const key = newSectionKey.trim();
    if (!key) return;
    try {
      const parsed = JSON.parse(draftJson) as Record<string, unknown>;
      if (key in parsed) {
        setJsonError(`字段 "${key}" 已存在`);
        return;
      }
      parsed[key] = null;
      setDraftJson(JSON.stringify(parsed, null, 2));
      setNewSectionKey("");
      setAddingSection(false);
      setJsonError(null);
    } catch {
      setJsonError("请先修正 JSON 格式错误再添加字段");
    }
  };

  const handleSave = async () => {
    let parsed: ProjectMemory;
    try {
      parsed = JSON.parse(draftJson) as ProjectMemory;
      setJsonError(null);
    } catch (e) {
      setJsonError("JSON 格式错误：" + String(e));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/document`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: parsed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存失败");
      onUpdated(parsed);
      setEditing(false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const progressLabel = Array.isArray(memory.current_progress) && memory.current_progress.length > 0
    ? `— ${memory.current_progress[memory.current_progress.length - 1].summary}`
    : null;

  const keys = sortedKeys(memory);

  return (
    <div className="rounded-xl border border-lark-border bg-lark-surface shadow-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-lark-sunken transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-lark-1 shrink-0">项目主文档</span>
          {progressLabel && (
            <span className="text-xs text-lark-3 truncate">{progressLabel}</span>
          )}
        </div>
        <ChevronRight
          size={15}
          className={`text-lark-3 transition-transform duration-200 shrink-0 ml-2 ${expanded ? "rotate-90" : ""}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-lark-border px-5 py-4 space-y-4">
          {!editing ? (
            <>
              {keys.map((key) => {
                const value = memory[key];
                const label = KNOWN_LABELS[key] ?? key;
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-lark-3 uppercase tracking-wider">
                        {label}
                      </span>
                      {!KNOWN_LABELS[key] && (
                        <span className="text-xs text-lark-4 font-mono">{key}</span>
                      )}
                      {isEmpty(value) && (
                        <span className="text-xs text-lark-4">空</span>
                      )}
                    </div>
                    {!isEmpty(value) && <FieldValue fieldKey={key} value={value} />}
                  </div>
                );
              })}
              <button
                onClick={handleStartEdit}
                className="text-xs text-lark-blue hover:underline"
              >
                编辑主文档
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-lark-3">编辑 JSON（支持任意字段）</p>
                <button
                  onClick={() => setAddingSection((v) => !v)}
                  className="text-xs text-lark-blue hover:underline"
                >
                  + 新增字段
                </button>
              </div>

              {addingSection && (
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={newSectionKey}
                    onChange={(e) => setNewSectionKey(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddSection()}
                    placeholder="字段名（英文，如 deliverables）"
                    className="flex-1 px-3 py-1.5 border border-lark-border rounded-lg text-xs bg-lark-sunken text-lark-1 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 placeholder:text-lark-4"
                  />
                  <button
                    onClick={handleAddSection}
                    className="px-3 py-1.5 text-xs font-medium bg-lark-blue text-white rounded-lg hover:bg-lark-blue-hover transition-colors"
                  >
                    添加
                  </button>
                  <button
                    onClick={() => { setAddingSection(false); setNewSectionKey(""); }}
                    className="text-xs text-lark-2 hover:text-lark-1 transition-colors"
                  >
                    取消
                  </button>
                </div>
              )}

              <textarea
                value={draftJson}
                onChange={(e) => { setDraftJson(e.target.value); setJsonError(null); }}
                rows={24}
                spellCheck={false}
                className="w-full px-3 py-2.5 border border-lark-border rounded-lg text-xs font-mono bg-lark-sunken text-lark-1 resize-none focus:outline-none focus:ring-2 focus:ring-lark-blue/40 transition-colors"
              />
              {jsonError && <p className="text-xs text-lark-danger">{jsonError}</p>}
              {saveError && <p className="text-xs text-lark-danger">{saveError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 transition-colors"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
                <button
                  onClick={() => { setEditing(false); setJsonError(null); setSaveError(null); setAddingSection(false); }}
                  className="px-4 py-1.5 rounded-lg text-sm text-lark-2 border border-lark-border hover:bg-lark-sunken transition-colors"
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
