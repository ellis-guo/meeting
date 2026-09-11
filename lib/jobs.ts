import { hostname } from "node:os";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { encryptJSON, decryptJSON } from "@/lib/crypto";

// 后台任务队列。
//
// 在此之前所有后台工作都是裸 `(async () => {...})().catch()`：进程一重启就
// 静默消失，只能靠 ProcessingLog 事后猜。dreaming 是每晚无人值守跑的，没有
// 一张表根本无从知道它昨晚死没死、花了多少 token。
//
// ⚠️ 全文不使用 SQL 的 now()。Job 的时间列是 timestamp WITHOUT time zone，
// Prisma 往里写 UTC；而 now() 转成 timestamp 时按的是**数据库会话时区**。
// 本地 Docker 镜像恰好是 Etc/UTC 所以碰巧一致，但生产是 Ubuntu 上自建
// PostgreSQL（见 plan/phase7-deploy.md Step 25），那台机器若为 Asia/Shanghai，
// `run_after <= now()` 会整体偏 8 小时——凌晨 1 点的 dreaming 会在前一天下午
// 被抢走。所有时间一律从 JS 传 Date 参数，与数据库时区无关。

export type JobType = "transcribe" | "summarize" | "reindex" | "dreaming";
export type JobStatus = "queued" | "running" | "done" | "failed";

/**
 * 租约：locked_at 超过这个时长没有心跳，就认为 worker 已经崩了。
 *
 * 不能简单地把租约设成"最长任务耗时"——dreaming 在大项目上可能跑几十分钟，
 * 而租约越长，worker 真崩掉后卡住的时间也越长。所以租约取短，由运行中的任务
 * 靠心跳续期。没有心跳只有长租约的话，一个跑了 11 分钟的正常任务会被回收成
 * queued 然后被另一个 worker 重复执行——两份 LLM 账单，还互相写脏索引层。
 */
export const LEASE_MS = 5 * 60_000;
/** 心跳间隔，必须显著小于 LEASE_MS，留出抖动和 GC 停顿的余量。 */
export const HEARTBEAT_MS = 60_000;

/** 失败重试的间隔。attempts 在抢占时就已 +1，所以下标 = 已失败次数 - 1。 */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** worker 标识。PM2 cluster 下每个进程要能区分，否则回收日志分不清是谁卡的。 */
export function workerId(): string {
  const instance = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? String(process.pid);
  return `${hostname()}#${instance}`;
}

export type ClaimedJob = {
  id: string;
  user_id: string;
  project_id: string | null;
  type: JobType;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

type RawClaim = {
  id: string;
  user_id: string;
  project_id: string | null;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
};

export async function enqueue(input: {
  userId: string;
  projectId?: string | null;
  type: JobType;
  payload?: unknown;
  /** 不传 = 立刻可取。dreaming 用它做 0–30min 抖动，避免整点齐发打满 DashScope。 */
  runAfter?: Date;
  maxAttempts?: number;
}): Promise<string> {
  const job = await prisma.job.create({
    data: {
      user_id: input.userId,
      project_id: input.projectId ?? null,
      type: input.type,
      // payload 可能含会议内容，与其它落库字段一样加密
      payload: input.payload === undefined ? "" : encryptJSON(input.payload),
      run_after: input.runAfter ?? new Date(),
      ...(input.maxAttempts !== undefined ? { max_attempts: input.maxAttempts } : {}),
    },
    select: { id: true },
  });
  return job.id;
}

/**
 * 取一个待办任务并标记为 running。没有可取的返回 null。
 *
 * FOR UPDATE SKIP LOCKED：多个 worker 同时抢时，拿不到行锁的直接跳过这一行去
 * 看下一行，而不是排队等待。这是多 worker 抢任务的标准解法，也是这里必须写
 * 原生 SQL 的唯一原因（Prisma 没有对应 API）。
 *
 * types 限定只抢哪几类任务。**传空数组表示什么都不抢**——本进程没有注册任何
 * 处理函数时，抢到手只会白白烧掉一次 attempts 然后失败。不传 = 不限类型。
 */
export async function claimNext(
  worker: string = workerId(),
  types?: JobType[],
): Promise<ClaimedJob | null> {
  if (types && types.length === 0) return null;
  const typeFilter = types ? Prisma.sql`AND type IN (${Prisma.join(types)})` : Prisma.empty;
  const now = new Date();
  const rows = await prisma.$queryRaw<RawClaim[]>`
    UPDATE "Job" SET
      status = 'running',
      attempts = attempts + 1,
      locked_at = ${now},
      locked_by = ${worker},
      updated_at = ${now}
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'queued' AND run_after <= ${now} ${typeFilter}
      ORDER BY run_after ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, user_id, project_id, type, payload, attempts, max_attempts
  `;
  const row = rows[0];
  if (!row) return null;

  let payload: unknown = undefined;
  if (row.payload) {
    // 解不开的 payload 不该让整个 worker 崩：任务照常交出去，由处理函数
    // 自己决定 payload 缺失怎么办（多半是直接失败，走正常重试路径）。
    try { payload = decryptJSON(row.payload); } catch { payload = undefined; }
  }
  return { ...row, type: row.type as JobType, payload };
}

/** 续租。长任务必须周期性调用，否则会被 reclaimStale 当成崩溃回收。 */
export async function heartbeat(jobId: string): Promise<void> {
  // updateMany 而非 update：任务可能已被回收或删除，那时不该抛异常打断正在
  // 跑的业务逻辑——心跳失败本身不是业务失败。
  await prisma.job.updateMany({
    where: { id: jobId, status: "running" },
    data: { locked_at: new Date() },
  });
}

export async function complete(jobId: string, tokensUsed?: number): Promise<void> {
  await prisma.job.updateMany({
    where: { id: jobId },
    data: {
      status: "done",
      locked_at: null,
      locked_by: null,
      last_error: null,
      ...(tokensUsed !== undefined ? { tokens_used: tokensUsed } : {}),
    },
  });
}

/**
 * 记一次失败。没到 max_attempts 就退回 queued 并推迟重试，到了就置 failed。
 * 返回实际走的分支，方便调用方打日志。
 */
export async function fail(jobId: string, error: unknown): Promise<"retry" | "failed"> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { attempts: true, max_attempts: true },
  });
  if (!job) return "failed";

  // 存 stack 而不只是 message：无人值守跑的任务，事后只有这一条线索。
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const last_error = detail.slice(0, 4000);

  if (job.attempts >= job.max_attempts) {
    await prisma.job.updateMany({
      where: { id: jobId },
      data: { status: "failed", locked_at: null, locked_by: null, last_error },
    });
    return "failed";
  }

  const idx = Math.min(Math.max(job.attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
  await prisma.job.updateMany({
    where: { id: jobId },
    data: {
      status: "queued",
      locked_at: null,
      locked_by: null,
      last_error,
      run_after: new Date(Date.now() + RETRY_BACKOFF_MS[idx]),
    },
  });
  return "retry";
}

/**
 * 回收租约过期的 running 任务，返回回收条数。
 *
 * 注意不重置 attempts：一个每次都把 worker 搞崩的任务（毒丸）会照常把重试
 * 次数耗完然后进 failed，而不是永远被回收-重跑。
 */
export async function reclaimStale(leaseMs: number = LEASE_MS): Promise<number> {
  const now = new Date();
  const { count } = await prisma.job.updateMany({
    where: { status: "running", locked_at: { lt: new Date(now.getTime() - leaseMs) } },
    data: { status: "queued", locked_at: null, locked_by: null, run_after: now },
  });
  return count;
}

/**
 * 跑一个已抢到的任务：期间自动续租，结束后置 done 或按重试策略置 queued/failed。
 * 处理函数返回 tokensUsed 就记账（dreaming 每晚花多少要看得见）。
 */
export async function runJob(
  job: ClaimedJob,
  handler: (job: ClaimedJob) => Promise<{ tokensUsed?: number } | void>,
): Promise<"done" | "retry" | "failed"> {
  const timer = setInterval(() => { void heartbeat(job.id).catch(() => {}); }, HEARTBEAT_MS);
  // 心跳定时器不该拖住进程退出
  timer.unref?.();
  try {
    const result = await handler(job);
    await complete(job.id, result?.tokensUsed);
    return "done";
  } catch (e) {
    return await fail(job.id, e);
  } finally {
    clearInterval(timer);
  }
}
