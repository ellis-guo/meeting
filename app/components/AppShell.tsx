"use client";

import Sidebar from "./Sidebar";
import { SidebarProvider } from "@/lib/SidebarContext";

/**
 * 全站外壳：左侧常驻导航 + 右侧内容列。
 *
 * 不放进 root layout，而是每个页面显式包一层。原因是登录 / 注册页不能有导航
 * （那时还没有用户，项目列表拉不到），放 layout 就得在里面按 pathname 分支，
 * 那等于把「哪些页面算应用内」这件事藏进一个组件里。显式包一层多一行，
 * 但每个页面自己说了算。
 *
 * fullHeight：会议详情、生成流程这类占满视口、内部自己滚动的工作区页面用。
 * 普通页面（首页、项目页、设置）走默认的 min-h-screen，整页滚动。
 */
export default function AppShell({
  children,
  fullHeight = false,
}: {
  children: React.ReactNode;
  fullHeight?: boolean;
}) {
  return (
    <SidebarProvider>
      <Sidebar />
      {/* lg:pl 给 fixed 侧边栏让位。lg 以下侧边栏是抽屉，不占位。
          min-w-0：内容列里有 flex 布局和长文本，不加这条它们会把整列撑宽，
          在窄屏上表现成整页横向滚动。 */}
      <div
        className={`lg:pl-[232px] min-w-0 ${fullHeight ? "h-screen" : "min-h-screen"} print:pl-0`}
      >
        {children}
      </div>
    </SidebarProvider>
  );
}
