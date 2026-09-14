"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Pencil, Printer, Trash2, X } from "lucide-react";
import AppHeader from "@/app/components/AppHeader";
import SummaryPanel from "@/app/components/SummaryPanel";
import TranscriptPanel from "@/app/components/TranscriptPanel";
import MeetingAskPanel from "@/app/components/MeetingAskPanel";
import { useConfirm } from "@/lib/ConfirmContext";
import { useMeetingDetail } from "@/lib/useMeetingDetail";
import MeetingProcessing from "@/app/components/MeetingProcessing";
import PanelTabs from "@/app/components/PanelTabs";

/** 手机上「摘要 / 逐字稿」只能二选一显示，md 以上并排，这个状态就没用了。 */
const PANEL_TABS = [
  { key: "summary", label: "摘要" },
  { key: "transcript", label: "逐字稿" },
] as const;
type PanelTab = (typeof PANEL_TABS)[number]["key"];

type PopupState = { sourceLines: number[]; x: number; y: number } | null;

export default function MeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const confirm = useConfirm();
  const projectId = params.id as string;
  const meetingId = params.meetingId as string;

  const { summary, setSummary, numberedTranscript, status, waiting, loading, notFound } =
    useMeetingDetail(meetingId);

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [popup, setPopup] = useState<PopupState>(null);
  const [mobileTab, setMobileTab] = useState<PanelTab>("summary");
  const [highlightedLines, setHighlightedLines] = useState<number[]>([]);

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
    const ok = await confirm({
      title: "确认删除这条会议记录？",
      description: "此操作不可撤销。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await fetch(`/api/meetings/${meetingId}`, { method: "DELETE" });
      toast.success("会议记录已删除");
      router.push(`/projects/${projectId}`);
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
        <Link href={`/projects/${projectId}`} className="text-sm text-lark-blue hover:underline">返回项目</Link>
      </div>
    );
  }

  if (waiting || status === "failed") {
    return <MeetingProcessing status={status} backHref={`/projects/${projectId}`} backLabel="返回项目" />;
  }

  const date = summary.meta.date ?? "—";

  return (
    <div className="h-screen flex flex-col bg-lark-surface">
      <AppHeader
        variant="app"
        back={{ label: "返回项目", onClick: () => router.push(`/projects/${projectId}`) }}
        title={<span className="text-sm text-lark-2">{date}</span>}
        actions={
          <>
            <button
              onClick={() => { setIsEditing((v) => !v); setPopup(null); }}
              className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isEditing
                  ? "bg-lark-blue text-white"
                  : "border border-lark-border text-lark-2 hover:bg-lark-sunken"
              }`}
            >
              <Pencil size={13} />
              {/* 手机上四个按钮加铃铛放不下，留图标去文字；title 保住可读性 */}
              <span className="hidden sm:inline">{isEditing ? "完成编辑" : "编辑"}</span>
            </button>
            {isEditing && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 transition-colors"
              >
                {saving ? "保存中..." : "保存"}
              </button>
            )}
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-border text-lark-2 hover:bg-lark-sunken transition-colors print:hidden"
            >
              <Printer size={13} />
              <span className="hidden sm:inline">导出 PDF</span>
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium border border-lark-danger/30 text-lark-danger hover:bg-lark-danger/5 disabled:opacity-50 transition-colors"
            >
              <Trash2 size={13} />
              <span className="hidden sm:inline">{deleting ? "删除中..." : "删除"}</span>
            </button>
          </>
        }
      />

      <PanelTabs
        tabs={PANEL_TABS}
        value={mobileTab}
        onChange={(k) => setMobileTab(k as PanelTab)}
      />

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* print:block 是给"手机上停在逐字稿那栏时去打印"兜底的——导出 PDF 永远只出
            摘要，不能因为当前切在另一栏就打印出一张空白页。 */}
        <div
          className={`w-full md:w-1/2 overflow-y-auto md:border-r border-lark-border p-4 sm:p-6 print:w-full print:border-none print:p-8 print:block ${
            mobileTab === "summary" ? "" : "hidden md:block"
          }`}
        >
          <SummaryPanel
            summary={summary}
            isEditing={isEditing}
            onSourceClick={handleSourceClick}
            onSummaryChange={setSummary}
          />
        </div>

        <div
          className={`w-full md:w-1/2 print:hidden overflow-hidden flex-col ${
            mobileTab === "transcript" ? "flex" : "hidden md:flex"
          }`}
        >
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-lark-sunken">
            <TranscriptPanel
              numberedTranscript={numberedTranscript}
              highlightedLines={highlightedLines}
            />
          </div>
        </div>
      </div>

      <MeetingAskPanel meetingId={meetingId} onLineClick={handleLineClick} />

      {popup && !isEditing && (
        <div
          className="fixed bg-lark-surface border border-lark-border rounded-xl p-4 z-50 min-w-44 max-w-[calc(100vw-1rem)] print:hidden"
          style={{
            // y 本来就有兜底，x 一直没有。375px 屏上只要点击位置靠右，
            // 176px 宽（min-w-44）的浮窗会整个溢出屏幕右边，根本看不到。
            left: Math.max(8, Math.min(popup.x, window.innerWidth - 184)),
            top: Math.min(popup.y, window.innerHeight - 220),
            boxShadow: "var(--lark-shadow-modal)",
          }}
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
