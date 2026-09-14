"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useApiKey } from "@/lib/ApiKeyContext";

// 只负责「粘逐字稿 → 交给后台」。
//
// 原来这个组件有 400 多行：一半是输入表单，另一半是生成完之后的工作区
// （摘要 + 逐字稿 + 编辑 + 问答）。后一半和会议详情页是重复的，而且它依赖
// SSE 一路流式推过来——用户必须等在页面上，中途关掉这次就白提交了。
//
// 现在提交即建任务、立刻跳到会议详情页（PRD 4.2）。生成在后台跑，跑完发通知。
// 那套工作区就是会议详情页本身，不需要再实现一遍。

type Props = { projectId?: string };

export default function MeetingFlow({ projectId }: Props) {
  const router = useRouter();
  const { status: keyStatus, loading: keyLoading, promptApiKey } = useApiKey();

  const [transcript, setTranscript] = useState("");
  const [date, setDate] = useState("");
  const [template, setTemplate] = useState<"smart" | "project">("smart");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!transcript.trim() || !date || submitting) return;
    if (keyLoading) return; // Key 状态还没查回来就弹窗，会误报“未配置”
    if (!keyStatus.configured) { promptApiKey(); return; }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/meeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          template,
          date,
          ...(projectId ? { project_id: projectId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "提交失败，请重试");
        setSubmitting(false);
        return;
      }
      // 不复位 submitting：跳转过程中按钮应该一直是禁用的
      router.push(
        projectId
          ? `/projects/${projectId}/meetings/${data.meeting_id}`
          : `/meetings/${data.meeting_id}`,
      );
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-lark-canvas p-8">
      <div className="w-full max-w-2xl space-y-4">
        <textarea
          className="w-full h-64 p-4 border border-lark-border rounded-xl text-sm text-lark-1 bg-lark-surface resize-none focus:outline-none focus:ring-2 focus:ring-lark-blue/40 placeholder:text-lark-4 shadow-card transition-colors"
          placeholder="粘贴会议记录..."
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          disabled={submitting}
        />
        <div className="flex gap-2">
          {(["smart", "project"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTemplate(t)}
              disabled={submitting}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                template === t
                  ? "bg-lark-blue text-white"
                  : "bg-lark-surface border border-lark-border text-lark-2 hover:bg-lark-sunken"
              }`}
            >
              {t === "smart" ? "智能模板" : "项目进度"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-lark-2 shrink-0">会议日期</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            disabled={submitting}
            className="flex-1 px-3 py-2 border border-lark-border rounded-lg text-sm text-lark-1 bg-lark-surface focus:outline-none focus:ring-2 focus:ring-lark-blue/40 transition-colors"
          />
        </div>
        {error && <p className="text-sm text-lark-danger">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={!transcript.trim() || !date || submitting}
          className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {submitting ? "正在录入..." : "开始录入"}
        </button>
        <p className="text-xs text-lark-4 text-center">
          交给我们就行，不用等在这页。整理好了会通知你。
        </p>
      </div>
    </div>
  );
}
