"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2, Mic, NotebookPen } from "lucide-react";

/**
 * 项目的三个输入入口（PRD 4.1）。
 *
 * 三个入口在界面上**分开呈现**，不合并成一个「上传」按钮——用户心里这三件事
 * 就是不同的：录一段会、贴一份记录、传一份资料。合并之后用户得先想清楚
 * "我这个算哪类"才能点，而那正是系统该替他判断的。
 *
 *     录音        ─┐
 *     会议记录    ─┼─→  发言稿（→ 会议记录） ─┐
 *                  │                          ├─→ 索引层
 *     文件        ─┴─→  参考文档               ─┘
 *
 * ⚠️ 录音入口是 disabled 的，**不能**改成可点。
 * `JobType` 里虽然已经有 "transcribe"，但 registerJobs.ts 没注册它的处理函数，
 * 而 jobRunner 只认注册表——没注册的类型不会被抢走。真让它排上任务的话，
 * 任务会安静地躺在队列里永远 queued：不报错、不失败、不超时，用户看到的是
 * 「一直在处理中」。要放开这个入口，必须先有 transcribeHandler 并注册。
 */

type EntryProps = {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string;
  busy?: boolean;
  /** 拖拽高亮（只有「文件」入口用）。 */
  active?: boolean;
} & React.HTMLAttributes<HTMLDivElement>;

function Entry({
  icon, label, hint, onClick, disabled, badge, busy, active, ...rest
}: EntryProps) {
  return (
    <div
      {...rest}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      // 名字要显式给：role="button" 的 div 靠内容推名字，这里的内容是
      // 图标 + 嵌套的标题/徽标/说明，读屏念出来是一串碎片。
      aria-label={badge ? `${label}（${badge}）` : label}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); }
      }}
      className={`group relative flex items-center gap-3 rounded-lg border px-4 py-3.5 text-left transition-colors ${
        disabled
          ? "border-tm-border-light bg-tm-surface cursor-not-allowed"
          : active
            ? "border-tm-brand bg-tm-brand-light cursor-pointer"
            : "border-tm-border bg-tm-surface hover:border-tm-brand hover:bg-tm-brand-light cursor-pointer"
      }`}
    >
      <span
        className={`flex items-center justify-center w-9 h-9 rounded-md shrink-0 transition-colors ${
          disabled ? "bg-tm-sunken text-tm-4" : "bg-tm-brand-light text-tm-brand group-hover:bg-tm-brand group-hover:text-white"
        }`}
      >
        {busy ? <Loader2 size={17} className="animate-spin" /> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`text-sm font-medium truncate ${disabled ? "text-tm-3" : "text-tm-1"}`}>
            {label}
          </span>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-tm-sunken text-tm-3 shrink-0 font-normal">
              {badge}
            </span>
          )}
        </div>
        <p className={`text-xs mt-0.5 truncate ${disabled ? "text-tm-4" : "text-tm-3"}`}>
          {busy ? "上传中..." : hint}
        </p>
      </div>
    </div>
  );
}

export default function SourceEntries({
  projectId,
  uploading,
  onFiles,
  onPickFile,
}: {
  projectId: string;
  uploading: boolean;
  onFiles: (files: FileList | File[]) => void;
  /** 打开文件选择框。input 由使用方渲染（和文件列表共用一个）。 */
  onPickFile: () => void;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Entry
        icon={<Mic size={17} />}
        label="上传录音"
        hint="转写后生成会议记录"
        badge="即将支持"
        disabled
      />
      <Entry
        icon={<NotebookPen size={17} />}
        label="会议记录"
        hint="粘贴会议平台导出的文字记录"
        onClick={() => router.push(`/projects/${projectId}/meetings/new`)}
      />
      <Entry
        icon={<FileUp size={17} />}
        label="上传文件"
        hint="PDF / Word / 纯文本，可拖拽"
        busy={uploading}
        active={dragging}
        onClick={onPickFile}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
        }}
      />
    </div>
  );
}
