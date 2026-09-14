import { prisma } from "@/lib/prisma";
import { decrypt, encryptJSON } from "@/lib/crypto";
import { addLineNumbers, extractJSON } from "@/lib/utils";
import { callDashScope, FAST_CHAT_MODEL } from "@/lib/dashscope";
import { SUMMARY_SMART_PROMPT, SUMMARY_PROGRESS_PROMPT } from "@/lib/prompts";
import {
  buildSummaryChunks, buildTranscriptChunks, insertChunks, type Summary,
} from "@/lib/chunking";
import { markIndexDirty } from "@/lib/dreaming";
import { enqueue, type ClaimedJob } from "@/lib/jobs";

// summarize 的处理函数：逐字稿 → 会议记录。
//
// 这一步原来是挂在 SSE 上的：用户提交后必须**等在页面上**看着摘要一个字一个字
// 生成，中途关掉页面这次就白提交了。PRD 4.2 要的是反过来——上传即建任务、立即
// 返回「正在录入 XX 项目」，生成在后台跑完再通知。
//
// 代价是没有了逐字流式的观感；换来的是：关掉页面照样跑完、进程崩了能被
// reclaimStale 捡回来重试、失败有记录而不是一句 toast 就没了。

export type SummarizePayload = {
  meetingId: string;
  template: "smart" | "project";
  /** 输出语言规则，请求作用域的东西（读 Accept-Language），必须随任务带过来。 */
  langRule: string;
  date?: string | null;
  time?: string | null;
};

function isPayload(v: unknown): v is SummarizePayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as SummarizePayload;
  return typeof o.meetingId === "string" && typeof o.langRule === "string";
}

async function log(meetingId: string, level: string, context: Record<string, unknown>): Promise<void> {
  await prisma.processingLog
    .create({ data: { level, meeting_id: meetingId, context: encryptJSON(context) } })
    .catch(() => {});
}

/**
 * 模型偶发漏字段。下面所有代码都假设 meta / sections 存在，这里显式兜底——
 * 否则直接抛 TypeError，而这是个后台任务，抛了只会进重试，下一次大概率还是同样
 * 的输出，白烧三次。
 */
function normalizeSummary(raw: unknown): Summary {
  const s = (raw ?? {}) as Summary;
  if (!s.meta || typeof s.meta !== "object") {
    s.meta = { date: null, time: null, participants: [] };
  }
  if (!Array.isArray(s.meta.participants)) s.meta.participants = [];
  if (!Array.isArray(s.sections)) s.sections = [];
  return s;
}

export async function runSummarize(job: ClaimedJob): Promise<{ tokensUsed?: number } | void> {
  if (!isPayload(job.payload)) throw new Error("summarize 的 payload 形状不对");
  const { meetingId, template, langRule, date, time } = job.payload;

  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, user_id: true, project_id: true, transcript: true, processing_status: true },
  });
  // 会议在排队期间被删了。该做的事已经不存在了，不是失败。
  if (!meeting) return;

  let transcript: string;
  try {
    transcript = decrypt(meeting.transcript);
  } catch {
    // 解不开重试也解不开。记成失败就走，别烧重试次数。
    await prisma.meeting.updateMany({ where: { id: meetingId }, data: { processing_status: "failed" } });
    await log(meetingId, "error", { type: "summarize_transcript_unreadable" });
    return;
  }

  // 不能用 getDashScopeKey()：它读 cookie + Clerk auth，都是请求作用域的。
  const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY 未配置，无法生成会议记录");

  await prisma.meeting.updateMany({
    where: { id: meetingId },
    data: { processing_status: "processing" },
  });

  const numbered = addLineNumbers(transcript);
  const systemPrompt = template === "project" ? SUMMARY_PROGRESS_PROMPT : SUMMARY_SMART_PROMPT;
  const context = [
    langRule,
    date ? `会议日期：${date}` : null,
    time ? `会议时间：${time}` : null,
    `以下是会议记录：\n\n${numbered}`,
  ].filter(Boolean).join("\n\n");

  const { content, usage } = await callDashScope(systemPrompt, context, apiKey, FAST_CHAT_MODEL);

  let parsed: unknown;
  try {
    parsed = extractJSON(content);
  } catch {
    // 模型没吐出合法 JSON。这**值得重试**——同一份输入再跑一次经常就好了，
    // 和"逐字稿解不开"那种确定性失败不是一回事。抛出去交给队列退避重试。
    await log(meetingId, "warn", { type: "summarize_bad_json", head: content.slice(0, 300) });
    throw new Error("模型返回的不是合法 JSON");
  }

  const summary = normalizeSummary(parsed);
  const today = new Date().toISOString().slice(0, 10);
  const meetingDate = date || summary.meta.date || today;
  summary.meta.date = meetingDate;

  // 顺序有意：totalLines 由逐字稿切分算出（过滤空行后从 1 开始，和喂给模型的
  // addLineNumbers 同一基准），summary 的 source_lines 要按它校验。
  const { chunks: transcriptChunks, matchedLines, totalLines } =
    buildTranscriptChunks(transcript, meetingId, meeting.project_id ?? undefined, meetingDate);
  const { chunks: summaryChunks, droppedLines } =
    buildSummaryChunks(summary, meetingId, meeting.project_id ?? undefined, totalLines ?? null);

  // 逐字稿格式对不上（不是腾讯会议那种 `说话人(时:分:秒): 正文`）时只留摘要块：
  // 切出来的"逐字稿块"会是一堆没有说话人、行号也对不上的碎片。
  const formatOk = totalLines === 0 || matchedLines / totalLines >= 0.3;
  if (!formatOk) {
    await log(meetingId, "warn", {
      type: "transcript_format_mismatch", matched_lines: matchedLines, total_lines: totalLines,
    });
  }
  // 模型报了原文里不存在的行号。锚点已被丢弃（宁可没有也不要错的），但要留痕：
  // 这是 prompt 质量的直接信号，静默丢掉就再也发现不了。
  if (droppedLines > 0) {
    await log(meetingId, "warn", {
      type: "source_lines_out_of_range", dropped: droppedLines, total_lines: totalLines,
    });
  }

  // 重跑要先清干净：这个任务可能是重试，上一次也许已经插了一半。
  await prisma.chunk.deleteMany({ where: { meeting_id: meetingId } });
  await prisma.chunkParent.deleteMany({ where: { meeting_id: meetingId } });
  await insertChunks(formatOk ? [...summaryChunks, ...transcriptChunks] : summaryChunks);

  await prisma.meeting.update({
    where: { id: meetingId },
    data: { summary: encryptJSON(summary), processing_status: "done" },
  });

  // 项目多了一场会议 → 索引层过期，等 dreaming 重算
  await markIndexDirty(meeting.project_id);

  // 向量化单独排一个任务，不在这里做：它和摘要生成的失败模式完全不同
  // （一个是 LLM 输出不合法，一个是 embedding 接口抖动），混在一起重试会把
  // 已经成功的摘要再生成一遍。
  await enqueue({
    userId: meeting.user_id,
    projectId: meeting.project_id,
    type: "reindex",
    payload: { meetingId, mode: "initial" },
  });

  await notifyDone(meeting.user_id, meetingId, meeting.project_id, meetingDate);

  await log(meetingId, "info", {
    type: "meeting_summarized",
    sections: summary.sections.length,
    chunks: formatOk ? summaryChunks.length + transcriptChunks.length : summaryChunks.length,
    format_ok: formatOk,
    tokens: usage?.total_tokens ?? null,
  });

  return { tokensUsed: usage?.total_tokens };
}

/**
 * 完成通知。
 *
 * 语气是产品决策不是文案细节（PRD 4.2）：说「好啦，可以查看或修改」，不说
 * 「待你确认」。**默认继续，永不阻塞**——用户不理会系统照常往下走，用户改了
 * 就以用户的为准。原来那条"主文档更新待处理，待你确认"随 diff 流程一起删了。
 */
async function notifyDone(
  userId: string,
  meetingId: string,
  projectId: string | null,
  meetingDate: string,
): Promise<void> {
  let projectName: string | null = null;
  if (projectId) {
    projectName = (await prisma.project.findUnique({
      where: { id: projectId }, select: { name: true },
    }))?.name ?? null;
  }
  await prisma.notification
    .create({
      data: {
        user_id: userId,
        type: "meeting_ready",
        title: projectName ? `「${projectName}」的会议记录好啦` : "会议记录好啦",
        body: `${meetingDate} 的记录已经整理完成，可以查看或修改。`,
        link: projectId ? `/projects/${projectId}/meetings/${meetingId}` : `/meetings/${meetingId}`,
      },
    })
    .catch(() => {});
}
