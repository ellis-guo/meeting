"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import MeetingFlow from "@/app/components/MeetingFlow";
import { ProjectMemory } from "@/app/types";

export default function ProjectMeetingPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [projectName, setProjectName] = useState<string>("");
  const [projectDocument, setProjectDocument] = useState<ProjectMemory | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => r.json())
      .then((data) => {
        setProjectName(data.name ?? "");
        setProjectDocument(data.document ?? null);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950">
        <p className="text-sm text-gray-400">加载中...</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="px-6 py-3 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shrink-0 print:hidden flex items-center gap-3">
        <Link
          href={`/projects/${id}`}
          className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          ← {projectName || "项目"}
        </Link>
        <span className="text-gray-200 dark:text-zinc-700">|</span>
        <span className="text-sm text-gray-600 dark:text-gray-400">新建会议</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <MeetingFlow
          projectId={id}
          projectDocument={projectDocument ?? undefined}
          onDiffConfirmed={() => router.push(`/projects/${id}`)}
        />
      </div>
    </div>
  );
}
