/**
 * 项目列表的模块级共享 store（配合 useSyncExternalStore 使用）。
 *
 * 为什么要有这个：加了左侧导航之后，项目列表同时出现在两个地方（侧边栏 + 首页），
 * 而它会被四处改动——新建、重命名、删除。各自 fetch 的话，在项目页把名字改了，
 * 侧边栏还挂着旧名字，得刷新整页才对得上。
 *
 * 和 notifications 那个 store 的区别：项目不会被后台任务改，所以**不轮询**。
 * 只在第一个订阅者出现时拉一次，之后由改动方显式 refresh()。
 */

export type ProjectBrief = {
  id: string;
  name: string;
  created_at: string;
};

/**
 * failed 不是可有可无的。
 *
 * 首页靠 `loaded && projects.length === 0` 渲染"还没有项目"——如果请求失败时
 * 也走这一支，用户看到的是一个和"真的没有项目"一模一样的空状态，会以为数据
 * 丢了。commit f900a74 就是修这个，不能在搬进 store 的时候又丢回去。
 */
type Snapshot = { projects: ProjectBrief[]; loaded: boolean; failed: boolean };

/** SSR 和未登录时的快照。必须是稳定引用，否则 useSyncExternalStore 会无限重渲染。 */
const EMPTY: Snapshot = { projects: [], loaded: false, failed: false };

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function setSnapshot(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export function getSnapshot(): Snapshot {
  return snapshot;
}

export function getEmptySnapshot(): Snapshot {
  return EMPTY;
}

/** 未登录时传给 useSyncExternalStore，什么都不订阅。 */
export function noopSubscribe(): () => void {
  return () => {};
}

export async function refresh(): Promise<void> {
  // 同时在途的请求合并成一条：侧边栏和首页会在同一帧里各调一次 refresh。
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/projects");
      // 不判 res.ok 就 .json() 会在 500 空响应体上炸在 JSON 解析里，
      // 报出来的错和真实原因毫无关系——这个项目踩过一次。
      if (!res.ok) { setSnapshot({ ...snapshot, loaded: true, failed: true }); return; }
      const data = await res.json();
      if (!Array.isArray(data.projects)) {
        setSnapshot({ ...snapshot, loaded: true, failed: true });
        return;
      }
      setSnapshot({ projects: data.projects, loaded: true, failed: false });
    } catch {
      setSnapshot({ ...snapshot, loaded: true, failed: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * 本地就地改名，不等服务端往返。
 *
 * 项目页改完名字会立刻 PATCH 成功，这时再 refresh() 一次是多余的一轮请求，
 * 而且在慢网络上侧边栏会有半秒还挂着旧名字。
 */
export function patchName(id: string, name: string): void {
  if (!snapshot.projects.some((p) => p.id === id)) return;
  setSnapshot({
    ...snapshot,
    projects: snapshot.projects.map((p) => (p.id === id ? { ...p, name } : p)),
  });
}

/** 删除后就地移除。同理，避免删完跳首页时侧边栏还留着那一项。 */
export function removeLocal(id: string): void {
  if (!snapshot.projects.some((p) => p.id === id)) return;
  setSnapshot({ ...snapshot, projects: snapshot.projects.filter((p) => p.id !== id) });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 第一个订阅者负责拉一次。已经拉过就不重复拉——页面间导航时侧边栏不卸载，
  // 但首页挂载时会新增订阅者，那时不该再打一次请求。
  // 上次失败过就再试一次：用户从失败的首页跳到别处再回来，不该一直停在错误态。
  if (listeners.size === 1 && (!snapshot.loaded || snapshot.failed)) void refresh();
  return () => {
    listeners.delete(listener);
  };
}
