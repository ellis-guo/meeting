"use client";

import Link from "next/link";
import { ArrowLeft, Menu } from "lucide-react";
import NotificationBell from "./NotificationBell";
import { useSidebar } from "@/lib/SidebarContext";

/** 返回入口：href 走 Link，onClick 走 button，二选一。 */
export type BackTarget = {
  label: string;
  href?: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
};

/** 面包屑的一节。最后一节通常不给 href（就是当前位置）。 */
export type Crumb = { label: string; href?: string };

interface Props {
  /**
   * page：普通页面顶栏（首页 / 设置 / 项目页），带 bg-tm-surface。
   * app：全屏工作区顶栏（会议详情 / 生成流程），打印时隐藏。
   */
  variant?: "page" | "app";
  /**
   * 返回入口。加了左侧导航之后大部分页面不再需要它——侧边栏本身就是返回路径。
   * 保留给**全屏工作区**：那类页面是"进去干一件事"，需要一个明确的退出口。
   */
  back?: BackTarget;
  /** 面包屑，排在标题之前。 */
  crumbs?: Crumb[];
  /** 标题节点，各页样式不同，原样渲染（项目页塞的是可编辑的 input）。 */
  title?: React.ReactNode;
  /** 右侧按钮，排在通知铃铛之前。 */
  actions?: React.ReactNode;
  /** 排在通知铃铛之后。 */
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
  "flex items-center gap-1.5 min-w-0 text-sm text-tm-2 hover:text-tm-1 disabled:opacity-40 transition-colors";

export default function AppHeader({
  variant = "page",
  back,
  crumbs,
  title,
  actions,
  trailing,
  wide = false,
}: Props) {
  const { setOpen } = useSidebar();

  // h-14 和侧边栏顶部的产品标识块等高，两条底边在桌面端连成一条线。
  // 手机上横向内距收到 px-4：375px 屏上 px-6/px-8 光左右就吃掉 48–64px。
  const pad = wide ? "px-4 sm:px-8" : "px-4 sm:px-6";
  const className =
    variant === "app"
      ? `h-14 flex items-center justify-between gap-2 ${pad} border-b border-tm-border bg-tm-surface shrink-0 print:hidden`
      : `h-14 flex items-center justify-between gap-2 ${pad} border-b border-tm-border bg-tm-surface`;

  const icon = <span className="shrink-0">{back?.icon ?? <ArrowLeft size={14} />}</span>;
  const backLabel = <span className="truncate">{back?.label}</span>;

  const hasCrumbs = crumbs && crumbs.length > 0;

  return (
    <header className={className}>
      {/* min-w-0 让左侧在空间不够时可以收缩（flex 子项默认 min-width:auto，
          不加这条标题就会把右侧按钮顶出屏幕），右侧 shrink-0 保住操作区。 */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {/* 汉堡：lg 以下出现（手机 + 平板），lg 起侧边栏常驻就不需要了 */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开导航"
          className="lg:hidden -ml-1.5 p-1.5 rounded-md text-tm-2 hover:bg-tm-hover transition-colors shrink-0 print:hidden"
        >
          <Menu size={18} />
        </button>

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
        {back && (hasCrumbs || title) && (
          <span className="text-tm-border shrink-0">|</span>
        )}

        {/* 面包屑。手机上整条藏起来——375px 上它和标题抢宽度，而标题更重要，
            位置信息在抽屉里已经有高亮了。 */}
        {hasCrumbs && (
          <nav className="hidden sm:flex items-center gap-1.5 min-w-0 shrink">
            {crumbs.map((c) => (
              <span key={c.label + (c.href ?? "")} className="flex items-center gap-1.5 min-w-0">
                {c.href ? (
                  <Link
                    href={c.href}
                    className="text-sm text-tm-2 hover:text-tm-brand transition-colors truncate max-w-[12rem]"
                    title={c.label}
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-sm text-tm-2 truncate max-w-[12rem]" title={c.label}>
                    {c.label}
                  </span>
                )}
                <span className="text-tm-4 shrink-0 select-none">/</span>
              </span>
            ))}
          </nav>
        )}

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
