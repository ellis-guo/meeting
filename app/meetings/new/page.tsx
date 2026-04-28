import MeetingFlow from "@/app/components/MeetingFlow";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function StandaloneMeetingPage() {
  return (
    <div className="h-screen flex flex-col">
      <div className="px-6 py-3.5 border-b border-lark-border bg-lark-surface shrink-0 print:hidden flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 transition-colors"
        >
          <ArrowLeft size={14} />
          首页
        </Link>
        <span className="text-lark-border">|</span>
        <span className="text-sm text-lark-2">独立会议</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <MeetingFlow />
      </div>
    </div>
  );
}
