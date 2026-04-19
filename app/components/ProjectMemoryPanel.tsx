"use client";

import { useState } from "react";
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

// Preferred display order for known fields
const FIELD_ORDER = [
  "overview", "goals", "members", "milestones", "current_progress",
  "key_decisions", "open_issues", "risks", "glossary", "checklist", "next_meeting_goals",
];

function renderItem(item: unknown): { icon: string | null; text: string } {
  if (typeof item === "string") return { icon: null, text: item };
  if (typeof item !== "object" || item === null) return { icon: null, text: String(item) };
  const o = item as Record<string, unknown>;
  if ("decision" in o) return { icon: null, text: `${o.date ? `[${o.date}] ` : ""}${o.decision}${o.rationale ? ` — ${o.rationale}` : ""}` };
  if ("issue" in o) return { icon: null, text: `${o.issue}${o.owner ? ` (${o.owner})` : ""}` };
  if ("risk" in o) return { icon: null, text: `${o.risk}${o.mitigation ? ` → ${o.mitigation}` : ""}` };
  if ("name" in o && "role" in o) return { icon: null, text: `${o.name} — ${o.role}` };
  if ("term" in o) return { icon: null, text: `${o.term}: ${o.definition}` };
  if ("item" in o && "status" in o) return { icon: o.status === "done" ? "✓" : "○", text: String(o.item) };
  if ("title" in o && "status" in o) return { icon: o.status === "done" ? "✓" : "○", text: `${o.date ? `${o.date}  ` : ""}${o.title}` };
  return { icon: null, text: JSON.stringify(item) };
}

function FieldValue({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-gray-400 dark:text-gray-500 italic text-sm">（空）</span>;

  if (fieldKey === "current_progress" && typeof value === "object" && !Array.isArray(value)) {
    const p = value as { summary: string; as_of: string };
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {p.summary}{" "}
        <span className="text-gray-400 dark:text-gray-500 text-xs">截至 {p.as_of}</span>
      </p>
    );
  }

  if (typeof value === "string")
    return <p className="text-sm text-gray-700 dark:text-gray-300">{value}</p>;

  if (Array.isArray(value)) {
    if (value.length === 0)
      return <span className="text-gray-400 dark:text-gray-500 italic text-sm">（空）</span>;
    return (
      <ul className="space-y-1">
        {value.map((item, i) => {
          const rendered = renderItem(item);
          return (
            <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
              <span className="text-gray-400 dark:text-gray-500 shrink-0">{rendered.icon ?? "•"}</span>
              <span>{rendered.text}</span>
            </li>
          );
        })}
      </ul>
    );
  }

  if (typeof value === "object")
    return <p className="text-sm font-mono text-gray-500 dark:text-gray-400">{JSON.stringify(value)}</p>;

  return <p className="text-sm text-gray-700 dark:text-gray-300">{String(value)}</p>;
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

  const progressLabel = memory.current_progress &&
    typeof memory.current_progress === "object" &&
    "summary" in (memory.current_progress as object)
      ? `— ${(memory.current_progress as { summary: string }).summary}`
      : null;

  const keys = sortedKeys(memory);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 shrink-0">项目主文档</span>
          {progressLabel && (
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{progressLabel}</span>
          )}
        </div>
        <span className={`text-gray-400 text-sm transition-transform shrink-0 ml-2 ${expanded ? "rotate-90" : ""}`}>▶</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 dark:border-zinc-800 px-5 py-4 space-y-4">
          {!editing ? (
            <>
              {keys.map((key) => {
                const value = memory[key];
                const label = KNOWN_LABELS[key] ?? key;
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
                        {label}
                      </span>
                      {!KNOWN_LABELS[key] && (
                        <span className="text-xs text-gray-300 dark:text-gray-600 font-mono">{key}</span>
                      )}
                      {isEmpty(value) && (
                        <span className="text-xs text-gray-300 dark:text-gray-600">空</span>
                      )}
                    </div>
                    {!isEmpty(value) && <FieldValue fieldKey={key} value={value} />}
                  </div>
                );
              })}
              <button
                onClick={handleStartEdit}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                编辑主文档
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400 dark:text-gray-500">编辑 JSON（支持任意字段）</p>
                <button
                  onClick={() => setAddingSection((v) => !v)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
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
                    className="flex-1 px-3 py-1.5 border border-gray-200 dark:border-zinc-700 rounded-lg text-xs bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleAddSection}
                    className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    添加
                  </button>
                  <button
                    onClick={() => { setAddingSection(false); setNewSectionKey(""); }}
                    className="text-xs text-gray-400 hover:text-gray-600"
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
                className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-700 rounded-lg text-xs font-mono bg-white dark:bg-zinc-800 text-gray-800 dark:text-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {jsonError && <p className="text-xs text-red-500">{jsonError}</p>}
              {saveError && <p className="text-xs text-red-500">{saveError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
                <button
                  onClick={() => { setEditing(false); setJsonError(null); setSaveError(null); setAddingSection(false); }}
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
