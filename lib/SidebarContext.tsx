"use client";

import { createContext, useContext, useMemo, useState } from "react";

/**
 * 移动端抽屉的开关状态。
 *
 * 为什么要 context：汉堡按钮在顶栏（AppHeader）里，抽屉本体在 AppShell 里，
 * 两者不是父子关系。把 state 提到 AppShell 再层层往下传的话，中间隔着每一个
 * 页面组件——每个页面都要多一个它根本不关心的 prop。
 *
 * 桌面端（md 以上）侧边栏是常驻的，这个状态不参与渲染。
 */
type SidebarState = {
  open: boolean;
  setOpen: (v: boolean) => void;
};

const SidebarContext = createContext<SidebarState>({ open: false, setOpen: () => {} });

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarState {
  return useContext(SidebarContext);
}
