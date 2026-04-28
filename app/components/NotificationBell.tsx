"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Bell, Check } from "lucide-react";

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  created_at: string;
};

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
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  const fetchAll = async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!isSignedIn) return;
    fetchAll();
    const t = setInterval(fetchAll, 60_000); // 每分钟轻量轮询
    return () => clearInterval(t);
  }, [isSignedIn]);

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

  const markRead = async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((prev) => Math.max(0, prev - 1));
    await fetch(`/api/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).catch(() => {});
  };

  const handleItemClick = async (n: Notification) => {
    if (!n.read) await markRead(n.id);
    setOpen(false);
    router.push(n.link);
  };

  const markAllRead = async () => {
    const unreadIds = items.filter((n) => !n.read).map((n) => n.id);
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    await Promise.all(
      unreadIds.map((id) =>
        fetch(`/api/notifications/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: true }),
        }).catch(() => {}),
      ),
    );
  };

  if (!isSignedIn) return null;

  return (
    <div ref={popoverRef} className="relative">
      <button
        onClick={() => {
          if (!open) fetchAll();
          setOpen((v) => !v);
        }}
        className="relative w-8 h-8 rounded-full hover:bg-lark-sunken flex items-center justify-center text-lark-2 hover:text-lark-1 transition-colors"
        aria-label="通知"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-lark-danger text-white text-[10px] font-medium flex items-center justify-center">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute top-10 right-0 w-80 max-h-[480px] rounded-xl bg-lark-surface border border-lark-border overflow-hidden flex flex-col z-50"
          style={{ boxShadow: "var(--lark-shadow-modal)" }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-lark-border">
            <span className="text-sm font-medium text-lark-1">通知</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-lark-blue hover:underline flex items-center gap-1"
              >
                <Check size={12} />
                全部已读
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-lark-3">暂无通知</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleItemClick(n)}
                  className={`w-full text-left px-4 py-3 border-b border-lark-border last:border-0 hover:bg-lark-sunken transition-colors ${
                    n.read ? "" : "bg-lark-blue-light/40"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.read && (
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-lark-blue shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-lark-1 truncate">{n.title}</p>
                      <p className="text-xs text-lark-3 mt-0.5 line-clamp-2">{n.body}</p>
                      <p className="text-[10px] text-lark-4 mt-1">{timeAgo(n.created_at)}</p>
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
