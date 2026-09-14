"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Pencil, Printer, Trash2, X } from "lucide-react";
import AppShell from "@/app/components/AppShell";
import AppHeader from "@/app/components/AppHeader";
import ModalityTag from "@/app/components/ModalityTag";
import SummaryPanel from "@/app/components/SummaryPanel";
import TranscriptPanel from "@/app/components/TranscriptPanel";
import MeetingAskPanel from "@/app/components/MeetingAskPanel";
import { useConfirm } from "@/lib/ConfirmContext";
import { useMeetingDetail } from "@/lib/useMeetingDetail";
import MeetingProcessing from "@/app/components/MeetingProcessing";
import PanelTabs from "@/app/components/PanelTabs";

type PopupState = { sourceLines: number[]; x: number; y: number } | null;

/** 手机上「摘要 / 逐字稿」只能二选一显示，md 以上并排，这个状态就没用了。 */
const PANEL_TABS = [
  { key: "summary", label: "摘要" },
  { key: "transcript", label: "逐字稿" },
] as const;
type PanelTab = (typeof PANEL_TABS)[number]["key"];

export default function StandaloneMeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const confirm = useConfirm();
  const meetingId = params.id as string;

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
      router.push("/");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <AppShell>
        <div className="h-[60vh] flex items-center justify-center">
          <p className="text-sm text-tm-3">加载中...</p>
        </div>
      </AppShell>
    );
  }

  if (notFound || !summary || !numberedTranscript) {
    return (
      <AppShell>
        <div className="h-[60vh] flex items-center justify-center flex-col gap-4">
          <p className="text-sm text-tm-2">会议记录不存在</p>
          <Link href="/" className="text-sm text-tm-brand hover:underline">返回工作台</Link>
        </div>
      </AppShell>
    );
  }

  if (waiting || status === "failed") {
    return <MeetingProcessing status={status} backHref={"/"} backLabel="返回首页" />;
  }

  const date = summary.meta.date ?? "—";

  return (
    <AppShell fullHeight>
      <div className="h-full flex flex-col bg-tm-surface">
      <AppHeader
        variant="app"
        crumbs={[{ label: "独立会议", href: "/" }]}
        title={
          // 标题可能没有（存量会议 / 模型没把握），那就只剩日期——不占位。
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm text-tm-2 tabular-nums shrink-0">{date}</span>
            {summary.meta.title?.trim() && (
              <span className="text-sm font-medium text-tm-1 truncate">
                {summary.meta.title.trim()}
              </span>
            )}
            <ModalityTag modality={summary.meta.modality} />
          </span>
        }
        actions={
          <>
            <button
              onClick={() => { setIsEditing((v) => !v); setPopup(null); }}
              title={isEditing ? "完成编辑" : "编辑"}
              className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isEditing
                  ? "bg-tm-brand text-white"
                  : "border border-tm-border text-tm-2 hover:bg-tm-sunken"
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
                className="px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium bg-tm-brand text-white hover:bg-tm-brand-hover disabled:opacity-50 transition-colors shrink-0"
              >
                {saving ? "保存中..." : "保存"}
              </button>
            )}
            <button
              onClick={() => window.print()}
              title="导出 PDF"
              className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium border border-tm-border text-tm-2 hover:bg-tm-sunken transition-colors"
            >
              <Printer size={13} />
              <span className="hidden sm:inline">导出 PDF</span>
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              title="删除"
              className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium border border-tm-danger/30 text-tm-danger hover:bg-tm-danger/5 disabled:opacity-50 transition-colors"
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
          className={`w-full md:w-1/2 overflow-y-auto md:border-r border-tm-border p-4 sm:p-6 print:w-full print:border-none print:p-8 print:block ${
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
          className={`w-full md:w-1/2 print:hidden overflow-y-auto p-4 sm:p-6 bg-tm-sunken ${
            mobileTab === "transcript" ? "" : "hidden md:block"
          }`}
        >
          <TranscriptPanel
            numberedTranscript={numberedTranscript}
            highlightedLines={highlightedLines}
          />
        </div>
      </div>

      <MeetingAskPanel meetingId={meetingId} onLineClick={handleLineClick} />

      {popup && !isEditing && (
        <div
          className="fixed bg-tm-surface border border-tm-border rounded-xl p-4 z-50 min-w-44 max-w-[calc(100vw-1rem)] print:hidden"
          style={{
            // y 本来就有兜底，x 一直没有。375px 屏上只要点击位置靠右，
            // 176px 宽（min-w-44）的浮窗会整个溢出屏幕右边，根本看不到。
            left: Math.max(8, Math.min(popup.x, window.innerWidth - 184)),
            top: Math.min(popup.y, window.innerHeight - 220),
            boxShadow: "var(--tm-shadow-modal)",
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-tm-3">来源</span>
            <button onClick={() => setPopup(null)} className="text-tm-3 hover:text-tm-1 transition-colors ml-4">
              <X size={14} />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {popup.sourceLines.map((lineNum, i) => (
              <button
                key={lineNum}
                onClick={() => handleLineClick(lineNum)}
                className="text-left text-sm text-tm-brand hover:underline"
              >
                来源 {i + 1}（第 {lineNum} 行）
              </button>
            ))}
          </div>
        </div>
      )}
      </div>
    </AppShell>
  );
}
