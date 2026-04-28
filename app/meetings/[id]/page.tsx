"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Pencil, Printer, Trash2, X } from "lucide-react";
import SummaryPanel from "@/app/components/SummaryPanel";
import TranscriptPanel from "@/app/components/TranscriptPanel";
import MeetingAskPanel from "@/app/components/MeetingAskPanel";
import { Summary } from "@/app/types";
import { addLineNumbers } from "@/lib/utils";

type PopupState = { sourceLines: number[]; x: number; y: number } | null;

export default function StandaloneMeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const meetingId = params.id as string;

  const [summary, setSummary] = useState<Summary | null>(null);
  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [popup, setPopup] = useState<PopupState>(null);
  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);

  useEffect(() => {
    fetch(`/api/meetings/${meetingId}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data) => {
        if (!data) return;
        setSummary(data.summary as Summary);
        setNumberedTranscript(addLineNumbers(data.transcript as string));
      })
      .finally(() => setLoading(false));
  }, [meetingId]);

  const handleSourceClick = (sourceLines: number[], x: number, y: number) => {
    if (isEditing) return;
    setPopup({ sourceLines, x, y });
  };

  const handleLineClick = (lineNum: number) => {
    setHighlightedLines([lineNum]);
    document.getElementById(`line-${lineNum}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleSave = async () => {
    if (!summary) return;
    setSaving(true);
    try {
      await fetch(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("确认删除这条会议记录？此操作不可撤销。")) return;
    setDeleting(true);
    try {
      await fetch(`/api/meetings/${meetingId}`, { method: "DELETE" });
      toast.success("会议记录已删除");
      router.push("/");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-lark-canvas">
        <p className="text-sm text-lark-3">加载中...</p>
      </div>
    );
  }

  if (notFound || !summary || !numberedTranscript) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-lark-canvas flex-col gap-4">
        <p className="text-sm text-lark-2">会议记录不存在</p>
        <Link href="/" className="text-sm text-lark-blue hover:underline">返回首页</Link>
      </div>
    );
  }

  const date = summary.meta.date ?? "—";

  return (
    <div className="h-screen flex flex-col bg-lark-surface">
      <header className="flex items-center justify-between px-6 py-3 border-b border-lark-border shrink-0 print:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 transition-colors"
          >
            <ArrowLeft size={14} />
            首页
          </button>
          <span className="text-lark-border">|</span>
          <span className="text-sm text-lark-2">{date}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setIsEditing((v) => !v); setPopup(null); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isEditing
                ? "bg-lark-blue text-white"
                : "border border-lark-border text-lark-2 hover:bg-lark-sunken"
            }`}
          >
            <Pencil size={13} />
            {isEditing ? "完成编辑" : "编辑"}
          </button>
          {isEditing && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 transition-colors"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          )}
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-border text-lark-2 hover:bg-lark-sunken transition-colors"
          >
            <Printer size={13} />
            导出 PDF
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-danger/30 text-lark-danger hover:bg-lark-danger/5 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={13} />
            {deleting ? "删除中..." : "删除"}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className="w-1/2 print:w-full overflow-y-auto border-r border-lark-border print:border-none p-6 print:p-8">
          <SummaryPanel
            summary={summary}
            isEditing={isEditing}
            onSourceClick={handleSourceClick}
            onSummaryChange={setSummary}
          />
        </div>
        <div className="w-1/2 print:hidden overflow-y-auto p-6 bg-lark-sunken">
          <TranscriptPanel
            numberedTranscript={numberedTranscript}
            highlightedLines={highlightedLines}
          />
        </div>
      </div>

      <MeetingAskPanel meetingId={meetingId} onLineClick={handleLineClick} />

      {popup && !isEditing && (
        <div
          className="fixed bg-lark-surface border border-lark-border rounded-xl p-4 z-50 min-w-44 print:hidden"
          style={{ left: popup.x, top: Math.min(popup.y, window.innerHeight - 220), boxShadow: "var(--lark-shadow-modal)" }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-lark-3 uppercase tracking-wider">来源</span>
            <button onClick={() => setPopup(null)} className="text-lark-3 hover:text-lark-1 transition-colors ml-4">
              <X size={14} />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {popup.sourceLines.map((lineNum, i) => (
              <button
                key={lineNum}
                onClick={() => handleLineClick(lineNum)}
                className="text-left text-sm text-lark-blue hover:underline"
              >
                来源 {i + 1}（第 {lineNum} 行）
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
