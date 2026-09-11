import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";
import { enqueue } from "@/lib/jobs";

// dreaming 的排期：决定"谁、什么时候"该重算索引层。索引层具体怎么算不在这里。
//
// 分工：**事件决定什么该重算**（写入时把 index_dirty 置 true），
// **日程只决定什么时候有空干**（当地时间凌晨 1 点）。
// 反过来做——按日程无脑全量重算——会变成一笔与改动量无关的固定 LLM 开销。

/** 当地时间几点跑。 */
export const DREAM_HOUR = 1;
/** 抖动上限：同时区的用户不会在整点齐发，把 DashScope 的 QPS 打满触发 429。 */
export const JITTER_MAX_MS = 30 * 60_000;
/** 没有 UserSettings 行时的默认时区。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * 某个 IANA 时区当前是几点。时区名非法返回 null。
 *
 * 用 Intl 而不是自己加偏移量：夏令时地区的偏移量一年里会变，存死偏移必错。
 */
export function localHour(timeZone: string, at: Date): number | null {
  try {
    const text = new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", hour12: false,
    }).format(at);
    const hour = Number(text);
    // 部分 ICU 版本把午夜格式化成 "24" 而不是 "0"
    return Number.isInteger(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

/**
 * 标记某项目的索引层需要重算。
 *
 * **永不抛异常**：它被写入路径调用（建会议、改摘要、删会议），而那些地方摘要
 * 已经落库了，不能因为一个标志位写失败就把整个请求带崩。失败记 ProcessingLog
 * ——静默吞掉的话，索引层会永远停在旧版本而没人知道。
 */
export async function markIndexDirty(projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  try {
    // updateMany 而非 update：项目可能刚被删掉，那时不该抛。
    await prisma.project.updateMany({
      where: { id: projectId },
      data: { index_dirty: true },
    });
  } catch (e) {
    await prisma.processingLog
      .create({
        data: {
          level: "error",
          meeting_id: null,
          context: encryptJSON({ type: "mark_index_dirty_failed", project_id: projectId, error: String(e) }),
        },
      })
      .catch(() => {});
  }
}

export type ScheduleResult = {
  dirty_projects: number;
  users_due: number;
  enqueued: number;
  already_queued: number;
};

/**
 * 给所有"当地时间刚到 DREAM_HOUR、且索引层脏了"的项目排 dreaming 任务。
 *
 * 只查 index_dirty 的项目，所以没改过东西的项目一分钱不花。
 */
export async function scheduleDreaming(now: Date = new Date()): Promise<ScheduleResult> {
  const result: ScheduleResult = { dirty_projects: 0, users_due: 0, enqueued: 0, already_queued: 0 };

  const dirty = await prisma.project.findMany({
    where: { index_dirty: true },
    select: { id: true, user_id: true },
  });
  result.dirty_projects = dirty.length;
  if (dirty.length === 0) return result;

  const settings = await prisma.userSettings.findMany({
    where: { user_id: { in: [...new Set(dirty.map((p) => p.user_id))] } },
  });
  const byUser = new Map(settings.map((s) => [s.user_id, s]));

  // 已排队或在跑的 dreaming。tick 每小时打一次，当地时间 1 点那一小时内可能被
  // 打到多次（重试、手动触发），没有这一层会给同一个项目反复排任务。
  const inflight = await prisma.job.findMany({
    where: {
      type: "dreaming",
      status: { in: ["queued", "running"] },
      project_id: { in: dirty.map((p) => p.id) },
    },
    select: { project_id: true },
  });
  const busy = new Set(inflight.map((j) => j.project_id));

  const usersDue = new Set<string>();
  for (const project of dirty) {
    const setting = byUser.get(project.user_id);
    // 没有 UserSettings 行 = 用户从没进过设置页，按默认走，不能因此被漏掉
    if (setting && !setting.dreaming_enabled) continue;
    if (localHour(setting?.timezone ?? DEFAULT_TIMEZONE, now) !== DREAM_HOUR) continue;

    usersDue.add(project.user_id);
    if (busy.has(project.id)) { result.already_queued++; continue; }

    await enqueue({
      userId: project.user_id,
      projectId: project.id,
      type: "dreaming",
      runAfter: new Date(now.getTime() + Math.floor(Math.random() * JITTER_MAX_MS)),
    });
    busy.add(project.id);
    result.enqueued++;
  }
  result.users_due = usersDue.size;
  return result;
}
