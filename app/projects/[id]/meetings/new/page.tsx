"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import MeetingFlow from "@/app/components/MeetingFlow";
import AppShell from "@/app/components/AppShell";
import AppHeader from "@/app/components/AppHeader";

export default function ProjectMeetingPage() {
  const params = useParams();
  const id = params.id as string;

  const [projectName, setProjectName] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setProjectName(data?.name ?? ""))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <AppShell>
        <div className="h-[60vh] flex items-center justify-center">
          <p className="text-sm text-tm-3">加载中...</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell fullHeight>
      <div className="h-full flex flex-col">
        {/* 以前这里是手写的顶栏，没有通知铃铛。统一走 AppHeader 之后
            移动端也才有汉堡可以打开抽屉。
            面包屑里的项目名可以到 100 字，AppHeader 里已经 truncate 过了。 */}
        <AppHeader
          variant="app"
          crumbs={[{ label: projectName || "项目", href: `/projects/${id}` }]}
          title={<span className="text-sm font-medium text-tm-1 shrink-0">新建会议</span>}
        />
        <div className="flex-1 overflow-hidden">
          <MeetingFlow projectId={id} />
        </div>
      </div>
    </AppShell>
  );
}
