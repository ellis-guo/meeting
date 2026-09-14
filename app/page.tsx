"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { AlertCircle, ChevronRight, FileText, Plus } from "lucide-react";
import { Modality } from "./types";
import AppShell from "./components/AppShell";
import ModalityTag from "./components/ModalityTag";
import AppHeader from "./components/AppHeader";
import {
  getEmptySnapshot,
  getSnapshot,
  noopSubscribe,
  refresh as refreshProjects,
  subscribe,
} from "@/lib/projectsStore";

type StandaloneMeeting = {
  id: string;
  created_at: string;
  date: string | null;
  title: string | null;
  modality: Modality | null;
};

export default function Home() {
  const { isSignedIn } = useAuth();
  const [standaloneMeetings, setStandaloneMeetings] = useState<StandaloneMeeting[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(true);

  // 项目列表走共享 store：侧边栏也在渲染它，各拉一份的话改完名字两处会对不上。
  const { projects, loaded: projectsLoaded, failed: projectsFailed } = useSyncExternalStore(
    isSignedIn ? subscribe : noopSubscribe,
    isSignedIn ? getSnapshot : getEmptySnapshot,
    getEmptySnapshot,
  );

  // 自己接住异常，不在 effect 的同步路径上 .catch(setState)——那样会触发级联渲染
  // （eslint 的 react-hooks 规则会报）。
  const loadMeetings = useCallback(async () => {
    setMeetingsLoading(true);
    try {
      const res = await fetch("/api/meeting");
      // 不判 r.ok 就 .json() 会在 500 空响应体上炸在 JSON 解析里，报出来的错和
      // 真实原因毫无关系——这个项目踩过一次。
      if (!res.ok) return;
      const data = await res.json();
      setStandaloneMeetings(data.meetings ?? []);
    } catch {
      /* 独立会议是次要区块，拉不到就不渲染，不必单独给一个错误态 */
    } finally {
      setMeetingsLoading(false);
    }
  }, []);

  useEffect(() => { void loadMeetings(); }, [loadMeetings]);

  return (
    <AppShell>
      <AppHeader
        title={<h1 className="text-sm font-semibold text-tm-1">工作台</h1>}
        actions={
          <Link
            href="/projects/new"
            className="flex items-center gap-1.5 px-3 h-8 rounded-md text-sm font-medium bg-tm-brand text-white hover:bg-tm-brand-hover transition-colors"
          >
            <Plus size={14} />
            <span className="hidden sm:inline">新建项目</span>
          </Link>
        }
      />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <section className="space-y-2.5">
          <h2 className="text-sm font-medium text-tm-1">项目</h2>

          {!projectsLoaded && <p className="text-sm text-tm-3">加载中...</p>}

          {/* 加载失败必须和"没有数据"区分开——两者长得一模一样，用户会以为数据丢了 */}
          {projectsLoaded && projectsFailed && (
            <div className="rounded-lg border border-tm-border bg-tm-surface p-10 text-center space-y-3">
              <AlertCircle size={20} className="mx-auto text-tm-3" />
              <p className="text-sm text-tm-2">加载失败，没能读到你的项目列表</p>
              <p className="text-xs text-tm-3">这不代表数据丢了——是这次请求没成功。</p>
              <button
                type="button"
                onClick={() => void refreshProjects()}
                className="inline-flex items-center gap-1 text-sm text-tm-brand hover:underline"
              >
                重试
              </button>
            </div>
          )}

          {projectsLoaded && !projectsFailed && projects.length === 0 && (
            <div className="rounded-lg border border-dashed border-tm-border p-10 text-center space-y-2">
              <p className="text-sm text-tm-3">还没有项目</p>
              <Link
                href="/projects/new"
                className="inline-flex items-center gap-1 text-sm text-tm-brand hover:underline"
              >
                新建第一个项目
                <ChevronRight size={13} />
              </Link>
            </div>
          )}

          {projectsLoaded && !projectsFailed && projects.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-tm-border bg-tm-surface px-4 py-3.5 hover:border-tm-brand hover:bg-tm-brand-light transition-colors group"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-tm-1 truncate">{project.name}</div>
                    <div className="mt-0.5 text-xs text-tm-3">
                      创建于 {new Date(project.created_at).toLocaleDateString("zh-CN")}
                    </div>
                  </div>
                  <ChevronRight size={15} className="text-tm-4 group-hover:text-tm-brand transition-colors shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2.5">
          <h2 className="text-sm font-medium text-tm-1">独立会议</h2>

          <Link
            href="/meetings/new"
            className="flex items-center justify-between gap-2 rounded-lg border border-tm-border bg-tm-surface px-4 py-3.5 hover:border-tm-brand hover:bg-tm-brand-light transition-colors group"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex items-center justify-center w-9 h-9 rounded-md bg-tm-brand-light text-tm-brand shrink-0 group-hover:bg-tm-brand group-hover:text-white transition-colors">
                <FileText size={17} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-tm-1">记录一次会议</div>
                <div className="text-xs text-tm-3 mt-0.5 truncate">不关联项目，只出一份摘要</div>
              </div>
            </div>
            <ChevronRight size={15} className="text-tm-4 group-hover:text-tm-brand transition-colors shrink-0" />
          </Link>

          {!meetingsLoading && standaloneMeetings.length > 0 && (
            <ul className="rounded-lg border border-tm-border bg-tm-surface overflow-hidden divide-y divide-tm-border-light">
              {standaloneMeetings.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/meetings/${m.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-tm-sunken transition-colors"
                  >
                    <span className="text-sm text-tm-2 tabular-nums shrink-0 w-24">
                      {m.date ?? new Date(m.created_at).toLocaleDateString("zh-CN")}
                    </span>
                    {/* 标题缺席时这一格就空着——存量会议没有它，不编占位文案 */}
                    <span className="text-sm font-medium text-tm-1 truncate flex-1 min-w-0">
                      {m.title?.trim() || ""}
                    </span>
                    <ModalityTag modality={m.modality} />
                    <ChevronRight size={14} className="text-tm-4 shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </AppShell>
  );
}
