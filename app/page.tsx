"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Plus, Settings, FileText, ChevronRight } from "lucide-react";
import { Project } from "./types";

type StandaloneMeeting = { id: string; created_at: string; date: string | null };

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [standaloneMeetings, setStandaloneMeetings] = useState<StandaloneMeeting[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/projects").then((r) => r.json()),
      fetch("/api/meeting").then((r) => r.json()),
    ])
      .then(([projectsData, meetingsData]) => {
        setProjects(projectsData.projects ?? []);
        setStandaloneMeetings(meetingsData.meetings ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-lark-canvas">
      <header className="px-6 py-4 border-b border-lark-border bg-lark-surface flex items-center justify-between">
        <h1 className="text-sm font-semibold text-lark-1">会议总结</h1>
        <div className="flex items-center gap-2">
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
          <UserButton />
        </div>
      </header>

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

          {!loading && projects.length === 0 && (
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

          {!loading && projects.length > 0 && (
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
