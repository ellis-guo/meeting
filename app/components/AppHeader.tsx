"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import NotificationBell from "./NotificationBell";

/** 返回入口：href 走 Link，onClick 走 button，二选一。 */
export type BackTarget = {
  label: string;
  href?: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
};

interface Props {
  /**
   * page：普通页面顶栏（首页 / 设置 / 项目页），带 bg-lark-surface。
   * app：全屏工作区顶栏（会议详情 / 生成流程），更矮、打印时隐藏。
   */
  variant?: "page" | "app";
  back?: BackTarget;
  /** 标题节点，各页样式不同，原样渲染。 */
  title?: React.ReactNode;
  /** 右侧按钮，排在通知铃铛之前。 */
  actions?: React.ReactNode;
  /** 排在通知铃铛之后（首页的 UserButton）。 */
  trailing?: React.ReactNode;
  /** 项目页用 px-8。 */
  wide?: boolean;
}

// 窄屏上返回入口要「不换行 + 可截断」，两条缺一不可：
// - 没有 whitespace-nowrap：「首页」会被压成竖排的"首/页"。
// - 用 shrink-0 代替可截断：label 有时是**项目全名**（新建会议页就是），
//   不肯收缩就会把右侧的铃铛整个顶出屏幕。
// 所以：容器允许收缩（min-w-0），文字 truncate，图标 shrink-0。
const BACK_CLASS =
  "flex items-center gap-1.5 min-w-0 text-sm text-lark-2 hover:text-lark-1 disabled:opacity-40 transition-colors";

export default function AppHeader({
  variant = "page",
  back,
  title,
  actions,
  trailing,
  wide = false,
}: Props) {
  // 手机上横向内距收到 px-4：375px 屏上 px-6/px-8 光左右就吃掉 48–64px。
  const className =
    variant === "app"
      ? "flex items-center justify-between gap-2 px-4 sm:px-6 py-3 border-b border-lark-border shrink-0 print:hidden"
      : `${wide ? "px-4 sm:px-8" : "px-4 sm:px-6"} py-4 border-b border-lark-border bg-lark-surface flex items-center justify-between gap-2`;

  const icon = <span className="shrink-0">{back?.icon ?? <ArrowLeft size={14} />}</span>;
  const backLabel = <span className="truncate">{back?.label}</span>;

  return (
    <header className={className}>
      {/* min-w-0 让左侧在空间不够时可以收缩（flex 子项默认 min-width:auto，
          不加这条标题就会把右侧按钮顶出屏幕），右侧 shrink-0 保住操作区。 */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {back &&
          (back.href ? (
            <Link href={back.href} className={BACK_CLASS}>
              {icon}
              {backLabel}
            </Link>
          ) : (
            <button onClick={back.onClick} disabled={back.disabled} className={BACK_CLASS}>
              {icon}
              {backLabel}
            </button>
          ))}
        {back && title && <span className="text-lark-border shrink-0">|</span>}
        {title}
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {actions}
        <NotificationBell />
        {trailing}
      </div>
    </header>
  );
}
