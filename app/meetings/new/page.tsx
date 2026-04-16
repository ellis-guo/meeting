import MeetingFlow from "@/app/components/MeetingFlow";
import Link from "next/link";

export default function StandaloneMeetingPage() {
  return (
    <div className="h-screen flex flex-col">
      <div className="px-6 py-3 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shrink-0 print:hidden flex items-center gap-3">
        <Link
          href="/"
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          ← 首页
        </Link>
        <span className="text-gray-200 dark:text-zinc-700">|</span>
        <span className="text-sm text-gray-600 dark:text-gray-400">独立会议</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <MeetingFlow />
      </div>
    </div>
  );
}
