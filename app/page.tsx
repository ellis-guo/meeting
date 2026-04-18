"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Project } from "./types";

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => setProjects(data.projects ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950">
      <header className="px-8 py-5 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between">
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">会议总结</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
            title="设置"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
          <Link
            href="/projects/new"
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            + 新建项目
          </Link>
          <UserButton />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-8 py-10 space-y-10">
        {/* Standalone meeting entry */}
        <Link
          href="/meetings/new"
          className="block w-full rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm transition-all group"
        >
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-lg">🗒️</span>
                <span className="font-semibold text-gray-900 dark:text-gray-100">独立会议</span>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">快速总结单次会议，无需关联项目</p>
            </div>
            <span className="text-gray-300 dark:text-gray-600 group-hover:text-blue-400 transition-colors text-lg">→</span>
          </div>
        </Link>

        {/* Projects section */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">我的项目</h2>

          {loading && (
            <p className="text-sm text-gray-400 dark:text-gray-500">加载中...</p>
          )}

          {!loading && projects.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-zinc-800 p-10 text-center space-y-3">
              <p className="text-sm text-gray-400 dark:text-gray-500">还没有项目</p>
              <Link
                href="/projects/new"
                className="inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                新建第一个项目 →
              </Link>
            </div>
          )}

          {!loading && projects.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="block rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm transition-all"
                >
                  <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{project.name}</div>
                  <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                    创建于 {new Date(project.created_at).toLocaleDateString("zh-CN")}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
