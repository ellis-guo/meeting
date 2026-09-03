/**
 * 通知的模块级共享 store（配合 useSyncExternalStore 使用）。
 *
 * 放在组件外面有两个原因：
 * 1. 轮询定时器跟着「有没有订阅者」走，同时挂多个铃铛也只有一个定时器；
 * 2. 组件里不再需要在 useEffect 里同步 setState（react-hooks/set-state-in-effect）。
 */

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  created_at: string;
};

type Snapshot = { items: NotificationItem[]; unread: number };

const EMPTY: Snapshot = { items: [], unread: 0 };
const POLL_MS = 60_000;

let snapshot: Snapshot = EMPTY;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function setSnapshot(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export function getSnapshot(): Snapshot {
  return snapshot;
}

/** SSR 以及未登录时的快照，必须是稳定引用。 */
export function getEmptySnapshot(): Snapshot {
  return EMPTY;
}

/** 未登录时传给 useSyncExternalStore，什么都不订阅。 */
export function noopSubscribe(): () => void {
  return () => {};
}

export async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/notifications");
    if (!res.ok) return;
    const data = await res.json();
    setSnapshot({ items: data.items ?? [], unread: data.unread ?? 0 });
  } catch {
    /* 轮询失败静默，下一轮再试 */
  }
}

/** 第一个订阅者拉起轮询，最后一个订阅者离开时停掉。 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function patchRead(id: string): Promise<unknown> {
  return fetch(`/api/notifications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read: true }),
  }).catch(() => {});
}

export async function markRead(id: string): Promise<void> {
  const target = snapshot.items.find((n) => n.id === id);
  if (!target || target.read) return;
  setSnapshot({
    items: snapshot.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
    unread: Math.max(0, snapshot.unread - 1),
  });
  await patchRead(id);
}

export async function markAllRead(): Promise<void> {
  const unreadIds = snapshot.items.filter((n) => !n.read).map((n) => n.id);
  if (unreadIds.length === 0) return;
  setSnapshot({ items: snapshot.items.map((n) => ({ ...n, read: true })), unread: 0 });
  await Promise.all(unreadIds.map(patchRead));
}
