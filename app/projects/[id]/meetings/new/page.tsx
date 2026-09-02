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
      <div className="px-6 py-3.5 border-b border-lark-border bg-lark-surface shrink-0 print:hidden flex items-center gap-3">
        <Link
          href={`/projects/${id}`}
          className="flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 transition-colors"
        >
          <ArrowLeft size={14} />
          {projectName || "项目"}
        </Link>
        <span className="text-lark-border">|</span>
        <span className="text-sm text-lark-2">新建会议</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <MeetingFlow projectId={id} />
      </div>
    </div>
  );
}
