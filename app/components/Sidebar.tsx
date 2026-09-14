"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth, UserButton } from "@clerk/nextjs";
import { FileText, LayoutGrid, Plus, Settings } from "lucide-react";
import {
  getEmptySnapshot,
  getSnapshot,
  noopSubscribe,
  subscribe,
} from "@/lib/projectsStore";
import { useSidebar } from "@/lib/SidebarContext";

/**
 * 左侧导航。腾讯会议那套布局的主体：常驻的项目列表 + 固定入口。
 *
 * 之前全站只有顶栏，每个页面靠一个「← 返回」链接串起来，用户要跳到另一个项目
 * 得先回首页。项目是这个产品的组织单位（PRD 1.1），它就该一直在视野里。
 *
 * 渲染两次是刻意的：桌面端 fixed 常驻，移动端在抽屉里。共用同一个 <Nav/>，
 * 靠父容器决定形态——两套结构各写一遍的话，加一个入口要记得改两个地方。
 */

const ITEM =
  "flex items-center gap-2.5 h-9 px-3 rounded-md text-sm transition-colors min-w-0";
const ITEM_IDLE = "text-tm-2 hover:bg-tm-hover hover:text-tm-1";
const ITEM_ACTIVE = "bg-tm-brand-light text-tm-brand font-medium";

function Item({
  href,
  icon,
  label,
  active,
  onNavigate,
  title,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onNavigate: () => void;
  title?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      title={title ?? label}
      className={`${ITEM} ${active ? ITEM_ACTIVE : ITEM_IDLE}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

function Nav() {
  const pathname = usePathname();
  const { isSignedIn } = useAuth();
  const { setOpen } = useSidebar();

  const { projects, loaded } = useSyncExternalStore(
    isSignedIn ? subscribe : noopSubscribe,
    isSignedIn ? getSnapshot : getEmptySnapshot,
    getEmptySnapshot,
  );

  // 点任何一项都要关掉移动端抽屉。桌面端 setOpen(false) 是空操作。
  const close = () => setOpen(false);

  // 项目页、项目下的会议页、参考文件查看页都算"在这个项目里"，
  // 所以匹配前缀而不是全等——否则从项目页点进一次会议，侧边栏就没有高亮了。
  const activeProjectId = pathname.startsWith("/projects/")
    ? pathname.split("/")[2]
    : null;

  return (
    <div className="flex flex-col h-full bg-tm-surface">
      {/* 产品标识 */}
      <div className="h-14 flex items-center gap-2.5 px-4 shrink-0 border-b border-tm-border-light">
        <div className="w-6 h-6 rounded-md bg-tm-brand flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-semibold leading-none">会</span>
        </div>
        <span className="text-sm font-semibold text-tm-1 truncate">会议总结</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        <Item
          href="/"
          icon={<LayoutGrid size={15} />}
          label="工作台"
          active={pathname === "/"}
          onNavigate={close}
        />
        <Item
          href="/meetings/new"
          icon={<FileText size={15} />}
          label="独立会议"
          active={pathname.startsWith("/meetings")}
          onNavigate={close}
        />

        <div className="pt-4 pb-1 px-3 flex items-center justify-between">
          <span className="text-xs font-medium text-tm-3">项目</span>
          <Link
            href="/projects/new"
            onClick={close}
            title="新建项目"
            className="p-1 -mr-1 rounded text-tm-3 hover:text-tm-brand hover:bg-tm-hover transition-colors"
          >
            <Plus size={14} />
          </Link>
        </div>

        {loaded && projects.length === 0 && (
          <p className="px-3 py-2 text-xs text-tm-4">还没有项目</p>
        )}

        {projects.map((p) => (
          <Item
            key={p.id}
            href={`/projects/${p.id}`}
            // 圆点而不是文件夹图标：项目名本来就长，图标越轻标题能占的宽度越多
            icon={
              <span
                className={`block w-1.5 h-1.5 rounded-full ${
                  activeProjectId === p.id ? "bg-tm-brand" : "bg-tm-4"
                }`}
              />
            }
            label={p.name}
            title={p.name}
            active={activeProjectId === p.id}
            onNavigate={close}
          />
        ))}
      </nav>

      <div className="shrink-0 border-t border-tm-border-light p-2 space-y-0.5">
        <Item
          href="/settings"
          icon={<Settings size={15} />}
          label="设置"
          active={pathname === "/settings"}
          onNavigate={close}
        />
        <div className="flex items-center gap-2.5 h-9 px-3">
          <UserButton
            appearance={{ elements: { userButtonAvatarBox: { width: 20, height: 20 } } }}
          />
          <span className="text-sm text-tm-3 truncate">账号</span>
        </div>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const { open, setOpen } = useSidebar();

  return (
    <>
      {/* 桌面端：常驻。print:hidden —— 会议记录要打印，导航不该出现在纸上。 */}
      <aside className="hidden md:block fixed inset-y-0 left-0 w-[232px] border-r border-tm-border print:hidden">
        <Nav />
      </aside>

      {/* 移动端抽屉。整棵树始终挂载但 open 时才可见：常驻的话即使 hidden 也会
          订阅项目列表，未登录时倒是没请求，登录后就是两份订阅——不过 store 里
          listeners 是 Set，多一个订阅者不会多打一次请求，这里就不做条件渲染了，
          留着能做 transition。 */}
      <div
        className={`md:hidden fixed inset-0 z-40 print:hidden ${open ? "" : "pointer-events-none"}`}
        aria-hidden={!open}
      >
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
            open ? "opacity-100" : "opacity-0"
          }`}
        />
        <aside
          className={`absolute inset-y-0 left-0 w-[232px] border-r border-tm-border transition-transform duration-200 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <Nav />
        </aside>
      </div>
    </>
  );
}
