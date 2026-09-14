"use client";

import { useCallback, useEffect, useState } from "react";
import type { Summary } from "@/app/types";
import { addLineNumbers } from "@/lib/utils";

// 会议详情的加载 + 等生成。项目内会议页和独立会议页共用。
//
// 生成改成后台任务之后（PRD 4.2），用户提交完就被带到这个页面，而这时摘要还是
// 空的。所以页面必须能表达"还在整理"，并且自己等结果——否则用户看到的是一个
// 空白的会议，只能靠手动刷新。

/** pending/processing = 还在后台跑；done = 可以渲染；failed = 生成失败。 */
export type MeetingStatus = "pending" | "processing" | "done" | "failed" | null;

const PENDING: MeetingStatus[] = ["pending", "processing"];
const POLL_MS = 3000;

export function useMeetingDetail(meetingId: string) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [numberedTranscript, setNumberedTranscript] = useState<string | null>(null);
  const [status, setStatus] = useState<MeetingStatus>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // 自己接住异常，不让调用方在 effect 里写 .catch(setState)——那样是在 effect
  // 的同步路径上调 setState，会触发级联渲染（eslint 的 react-hooks 规则会报）。
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/meetings/${meetingId}`);
      // 不判 r.ok 就 .json() 会在 500 空响应体上炸在 JSON 解析里，
      // 报出来的错和真实原因毫无关系——这个项目踩过一次。
      if (!r.ok) { setNotFound(true); return; }
      const data = await r.json();
      setSummary(data.summary as Summary);
      setNumberedTranscript(addLineNumbers(data.transcript as string));
      setStatus((data.processing_status ?? null) as MeetingStatus);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => { void load(); }, [load]);

  // 轮询由 status 自己驱动：每次 load 更新 status → 这个 effect 重跑 → 还没跑完
  // 就再排一次；跑完了它什么都不排，自然停住。不写递归 setTimeout，那种写法在
  // 组件重渲染时容易留下两个定时器。
  useEffect(() => {
    if (!PENDING.includes(status)) return;
    const t = setTimeout(() => { void load(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [status, load]);

  return {
    summary, setSummary, numberedTranscript,
    status, waiting: PENDING.includes(status),
    loading, notFound,
  };
}
