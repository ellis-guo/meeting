"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Bell, Check } from "lucide-react";
import {
  NotificationItem,
  getEmptySnapshot,
  getSnapshot,
  markAllRead,
  markRead,
  noopSubscribe,
  refresh,
  subscribe,
} from "@/lib/notifications";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toISOString().slice(0, 10);
}

export default function NotificationBell() {
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 轮询由 store 负责：未登录时订阅一个空 store，不发请求。
  const { items, unread } = useSyncExternalStore(
    isSignedIn ? subscribe : noopSubscribe,
    isSignedIn ? getSnapshot : getEmptySnapshot,
    getEmptySnapshot,
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const handleItemClick = async (n: NotificationItem) => {
    if (!n.read) await markRead(n.id);
    setOpen(false);
    router.push(n.link);
  };

  if (!isSignedIn) return null;

  return (
    <div ref={popoverRef} className="relative">
      <button
        onClick={() => {
          if (!open) void refresh();
          setOpen((v) => !v);
        }}
        className="relative w-8 h-8 rounded-full hover:bg-tm-sunken flex items-center justify-center text-tm-2 hover:text-tm-1 transition-colors"
        aria-label="通知"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-tm-danger text-white text-[10px] font-medium flex items-center justify-center">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute top-10 right-0 w-80 max-h-[480px] rounded-xl bg-tm-surface border border-tm-border overflow-hidden flex flex-col z-50"
          style={{ boxShadow: "var(--tm-shadow-modal)" }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-tm-border">
            <span className="text-sm font-medium text-tm-1">通知</span>
            {unread > 0 && (
              <button
                onClick={() => void markAllRead()}
                className="text-xs text-tm-brand hover:underline flex items-center gap-1"
              >
                <Check size={12} />
                全部已读
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-tm-3">暂无通知</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleItemClick(n)}
                  className={`w-full text-left px-4 py-3 border-b border-tm-border last:border-0 hover:bg-tm-sunken transition-colors ${
                    n.read ? "" : "bg-tm-brand-light/40"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.read && (
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-tm-brand shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-tm-1 truncate">{n.title}</p>
                      <p className="text-xs text-tm-3 mt-0.5 line-clamp-2">{n.body}</p>
                      <p className="text-[10px] text-tm-4 mt-1">{timeAgo(n.created_at)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
