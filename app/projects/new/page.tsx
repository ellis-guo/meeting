"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AppHeader from "@/app/components/AppHeader";

// 建项目只要一个名字。
//
// 原来这里还有：「不需要主文档」开关、一个粘贴参考文件的大文本框、以及创建后
// 让用户确认 AI 生成的主文档初稿。三样都随主文档一起下线了（见 PRD 5.1/5.2）：
// 建项目时不生成任何内容，文档统一走项目页的「参考文件」入口上传——那条路能
// 存原件、能溯源到具体章节，而这里的文本框只是把内容塞进一份没人看的主文档。
//
// 不再需要 API key：这个页面已经不调模型了。

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "创建失败");
      router.push(`/projects/${data.project_id}`);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-lark-canvas">
      <AppHeader
        back={{ label: "首页", href: "/" }}
        title={<span className="text-sm font-medium text-lark-1">新建项目</span>}
      />

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-5">
        <div className="space-y-2">
          <label className="text-xs font-semibold text-lark-3 uppercase tracking-wider">项目名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleCreate(); } }}
            placeholder="例如：产品 Q2 规划"
            autoFocus
            maxLength={100}
            className="w-full px-4 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-surface text-lark-1 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 placeholder:text-lark-4 transition-colors"
          />
          <p className="text-xs text-lark-4">
            建完就能用。需求文档、规范这类材料进项目页的「参考文件」上传，会和会议记录一样进检索。
          </p>
        </div>

        {error && <p className="text-sm text-lark-danger">{error}</p>}

        <button
          onClick={handleCreate}
          disabled={loading || !name.trim()}
          className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "创建中..." : "创建项目"}
        </button>
      </div>
    </div>
  );
}
