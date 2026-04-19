"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ProjectMemory } from "@/app/types";
import ProjectMemoryPanel from "@/app/components/ProjectMemoryPanel";

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft preview state
  const [projectId, setProjectId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectMemory | null>(null);
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const referenceFiles = referenceText.trim() ? [referenceText.trim()] : [];
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), reference_files: referenceFiles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "创建失败");

      if (data.document_draft) {
        setProjectId(data.project_id);
        setDraft(data.document_draft as ProjectMemory);
      } else {
        router.push(`/projects/${data.project_id}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmDraft = async () => {
    if (!projectId || !draft) return;
    setSaving(true);
    setError(null);
    try {
      // Normalize key_decisions: keep only entries with a valid YYYY-MM-DD date
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      const cleanedDraft = {
        ...draft,
        key_decisions: (draft.key_decisions ?? []).filter(
          (d) => d && (d.date === null || (typeof d.date === "string" && dateRegex.test(d.date))),
        ),
      };

      const res = await fetch(`/api/projects/${projectId}/document`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: cleanedDraft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "保存失败");
      }
      router.push(`/projects/${projectId}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // Draft confirmation screen
  if (draft && projectId) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-950">
        <header className="px-8 py-5 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setDraft(null)} className="text-sm text-gray-500 hover:text-gray-700 transition-colors">← 返回</button>
            <span className="text-gray-200 dark:text-zinc-700">|</span>
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">确认项目主文档</span>
          </div>
          <button
            onClick={handleConfirmDraft}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "保存中..." : "确认并进入项目"}
          </button>
        </header>

        <div className="max-w-2xl mx-auto px-8 py-8 space-y-5">
          <p className="text-sm text-gray-500 dark:text-gray-400">AI 已根据参考文件生成初始主文档，请确认内容后进入项目。</p>
          <ProjectMemoryPanel
            projectId={projectId}
            memory={draft}
            onUpdated={setDraft}
            initialExpanded={true}
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      </div>
    );
  }

  // Creation form
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950">
      <header className="px-8 py-5 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center gap-3">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">← 首页</Link>
        <span className="text-gray-200 dark:text-zinc-700">|</span>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">新建项目</span>
      </header>

      <div className="max-w-2xl mx-auto px-8 py-10 space-y-6">
        <div className="space-y-2">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">项目名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：产品 Q2 规划"
            className="w-full px-4 py-2.5 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            参考文件 <span className="font-normal normal-case text-gray-400">（可选）</span>
          </label>
          <textarea
            value={referenceText}
            onChange={(e) => setReferenceText(e.target.value)}
            placeholder="粘贴项目介绍、背景文档、需求文档等文本内容，AI 将据此生成初始项目主文档..."
            className="w-full h-48 px-4 py-3 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-900 text-gray-800 dark:text-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
          />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <button
          onClick={handleCreate}
          disabled={loading || !name.trim()}
          className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (referenceText.trim() ? "AI 生成主文档中..." : "创建中...") : "创建项目"}
        </button>
      </div>
    </div>
  );
}
