"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { AlertCircle, Plus, Settings, FileText, ChevronRight } from "lucide-react";
import { Project } from "./types";
import AppHeader from "./components/AppHeader";

type StandaloneMeeting = { id: string; created_at: string; date: string | null };

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [standaloneMeetings, setStandaloneMeetings] = useState<StandaloneMeeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // 自己接住异常，不在 effect 的同步路径上 .catch(setState)——那样会触发级联渲染
  // （eslint 的 react-hooks 规则会报）。
  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [projectsRes, meetingsRes] = await Promise.all([
        fetch("/api/projects"),
        fetch("/api/meeting"),
      ]);
      // 不判 r.ok 就 .json() 会在 500 空响应体上炸在 JSON 解析里，报出来的错和
      // 真实原因毫无关系——这个项目踩过一次（登录后页面全空 +
      // "Failed to execute 'json' on 'Response'"）。
      //
      // 这里尤其要紧：失败必须有**可见**的错误态。原来两个 fetch 既不判 r.ok 也
      // 没有 .catch()，整个 Promise.all reject 成未捕获异常，两个 setState 都不
      // 执行，页面就停在"还没有项目"——和真的没有项目长得一模一样，用户和排查的
      // 人都会被误导到数据丢失的方向去。
      if (!projectsRes.ok || !meetingsRes.ok) { setLoadFailed(true); return; }
      const [projectsData, meetingsData] = await Promise.all([
        projectsRes.json(),
        meetingsRes.json(),
      ]);
      setProjects(projectsData.projects ?? []);
      setStandaloneMeetings(meetingsData.meetings ?? []);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="min-h-screen bg-lark-canvas">
      <AppHeader
        title={<h1 className="text-sm font-semibold text-lark-1">会议总结</h1>}
        actions={
          <>
            <Link
              href="/settings"
              className="p-1.5 rounded-lg text-lark-3 hover:text-lark-2 hover:bg-lark-sunken transition-colors"
              title="设置"
            >
              <Settings size={17} />
            </Link>
            <Link
              href="/projects/new"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover transition-colors"
            >
              <Plus size={14} />
              新建项目
            </Link>
          </>
        }
        trailing={<UserButton />}
      />

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* Standalone meeting entry */}
        <Link
          href="/meetings/new"
          className="flex items-center justify-between w-full rounded-xl border border-lark-border bg-lark-surface p-5 shadow-card hover:shadow-card-hover transition-all group"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-lark-blue-light flex items-center justify-center shrink-0">
              <FileText size={15} className="text-lark-blue" />
            </div>
            <div>
              <div className="text-sm font-medium text-lark-1">独立会议</div>
              <div className="text-xs text-lark-3 mt-0.5">快速总结单次会议，无需关联项目</div>
            </div>
          </div>
          <ChevronRight size={16} className="text-lark-4 group-hover:text-lark-blue transition-colors" />
        </Link>

        {/* Projects section */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-lark-3 uppercase tracking-wider">我的项目</h2>

          {loading && (
            <p className="text-sm text-lark-3">加载中...</p>
          )}

          {/* 加载失败必须和"没有数据"区分开——见上面 load() 里的注释 */}
          {!loading && loadFailed && (
            <div className="rounded-xl border border-dashed border-lark-border p-10 text-center space-y-3">
              <AlertCircle size={20} className="mx-auto text-lark-3" />
              <p className="text-sm text-lark-2">加载失败，没能读到你的项目列表</p>
              <p className="text-xs text-lark-3">
                这不代表数据丢了——是这次请求没成功。
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-1 text-sm text-lark-blue hover:underline"
              >
                重试
              </button>
            </div>
          )}

          {!loading && !loadFailed && projects.length === 0 && (
            <div className="rounded-xl border border-dashed border-lark-border p-10 text-center space-y-2">
              <p className="text-sm text-lark-3">还没有项目</p>
              <Link
                href="/projects/new"
                className="inline-flex items-center gap-1 text-sm text-lark-blue hover:underline"
              >
                新建第一个项目
                <ChevronRight size={13} />
              </Link>
            </div>
          )}

          {!loading && !loadFailed && projects.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="flex items-center justify-between rounded-xl border border-lark-border bg-lark-surface p-4 shadow-card hover:shadow-card-hover transition-all group"
                >
                  <div>
                    <div className="text-sm font-medium text-lark-1 truncate">{project.name}</div>
                    <div className="mt-0.5 text-xs text-lark-3">
                      创建于 {new Date(project.created_at).toLocaleDateString("zh-CN")}
                    </div>
                  </div>
                  <ChevronRight size={15} className="text-lark-4 group-hover:text-lark-blue transition-colors shrink-0 ml-2" />
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Standalone meetings section */}
        {!loading && standaloneMeetings.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold text-lark-3 uppercase tracking-wider">独立会议记录</h2>
            <div className="space-y-2">
              {standaloneMeetings.map((m) => (
                <Link
                  key={m.id}
                  href={`/meetings/${m.id}`}
                  className="flex items-center justify-between rounded-xl border border-lark-border bg-lark-surface px-4 py-3 shadow-card hover:shadow-card-hover transition-all group"
                >
                  <div className="text-sm text-lark-1">
                    {m.date ?? new Date(m.created_at).toLocaleDateString("zh-CN")}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-lark-3">
                      {new Date(m.created_at).toLocaleDateString("zh-CN")}
                    </span>
                    <ChevronRight size={14} className="text-lark-4 group-hover:text-lark-blue transition-colors" />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
