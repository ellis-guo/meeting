"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
        <Link
          href="/projects/new"
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
        >
          + 新建项目
        </Link>
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
