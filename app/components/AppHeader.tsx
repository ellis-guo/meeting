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

const BACK_CLASS =
  "flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 disabled:opacity-40 transition-colors";

export default function AppHeader({
  variant = "page",
  back,
  title,
  actions,
  trailing,
  wide = false,
}: Props) {
  const className =
    variant === "app"
      ? "flex items-center justify-between px-6 py-3 border-b border-lark-border shrink-0 print:hidden"
      : `${wide ? "px-8" : "px-6"} py-4 border-b border-lark-border bg-lark-surface flex items-center justify-between`;

  const icon = back?.icon ?? <ArrowLeft size={14} />;

  return (
    <header className={className}>
      <div className="flex items-center gap-3">
        {back &&
          (back.href ? (
            <Link href={back.href} className={BACK_CLASS}>
              {icon}
              {back.label}
            </Link>
          ) : (
            <button onClick={back.onClick} disabled={back.disabled} className={BACK_CLASS}>
              {icon}
              {back.label}
            </button>
          ))}
        {back && title && <span className="text-lark-border">|</span>}
        {title}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <NotificationBell />
        {trailing}
      </div>
    </header>
  );
}
