"use client";

import Link from "next/link";
import { AlertCircle, Loader2 } from "lucide-react";
import type { MeetingStatus } from "@/lib/useMeetingDetail";
import AppShell from "./AppShell";

/**
 * 会议还在后台生成 / 生成失败时的占位。
 *
 * 语气按 PRD 4.2：说「在整理了」「不用等在这页」，不说「请稍候」「处理中」。
 * 用户提交完就被带到这里，这段文案是他对这次提交唯一的反馈。
 */
export default function MeetingProcessing({
  status,
  backHref,
  backLabel,
}: {
  status: MeetingStatus;
  backHref: string;
  backLabel: string;
}) {
  const failed = status === "failed";
  return (
    <AppShell>
      <div className="min-h-screen flex items-center justify-center px-4 sm:px-8">
      <div className="max-w-md text-center space-y-4">
        {failed ? (
          <>
            <AlertCircle size={22} className="text-tm-danger mx-auto" />
            <p className="text-sm font-medium text-tm-1">这次没整理成功</p>
            <p className="text-sm text-tm-3">
              逐字稿已经存下来了，没有丢。可以删掉这条重新提交一次。
            </p>
          </>
        ) : (
          <>
            <Loader2 size={22} className="text-tm-brand mx-auto animate-spin" />
            <p className="text-sm font-medium text-tm-1">正在整理这次会议的记录</p>
            <p className="text-sm text-tm-3">
              不用等在这页，整理好了会通知你。这页会自己刷新。
            </p>
          </>
        )}
        <Link href={backHref} className="inline-block text-sm text-tm-brand hover:underline">
          {backLabel}
        </Link>
        </div>
      </div>
    </AppShell>
  );
}
