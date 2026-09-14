"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import MeetingFlow from "@/app/components/MeetingFlow";

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
      <div className="min-h-screen flex items-center justify-center bg-lark-canvas">
        <p className="text-sm text-lark-3">加载中...</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      {/* 这一条是手写的顶栏，不走 AppHeader（所以也没有通知铃铛）。窄屏上项目名
          可以很长，要能截断，否则会把「新建会议」挤出屏幕。 */}
      <div className="px-4 sm:px-6 py-3.5 border-b border-lark-border bg-lark-surface shrink-0 print:hidden flex items-center gap-2 sm:gap-3">
        <Link
          href={`/projects/${id}`}
          className="flex items-center gap-1.5 min-w-0 text-sm text-lark-2 hover:text-lark-1 transition-colors"
          title={projectName || "项目"}
        >
          <ArrowLeft size={14} className="shrink-0" />
          <span className="truncate">{projectName || "项目"}</span>
        </Link>
        <span className="text-lark-border shrink-0">|</span>
        <span className="text-sm text-lark-2 shrink-0">新建会议</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <MeetingFlow projectId={id} />
      </div>
    </div>
  );
}
