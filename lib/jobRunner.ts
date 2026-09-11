import { claimNext, fail, runJob, workerId, type ClaimedJob, type JobType } from "@/lib/jobs";

// 任务执行器：把队列里的任务取出来交给对应的处理函数。
//
// 处理函数用注册表而不是写死的 switch：各功能模块（dreaming、转写、重新索引）
// 各自注册自己的处理函数，这里不需要认识它们。更重要的是——**没注册处理函数的
// 类型不会被抢走**。否则一个还没实现的任务类型会被抢到手、立刻失败、烧完三次
// 重试进 failed，而它本该安静地在队列里等功能上线。

export type JobHandler = (job: ClaimedJob) => Promise<{ tokensUsed?: number } | void>;

const handlers = new Map<JobType, JobHandler>();

export function registerHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function registeredTypes(): JobType[] {
  return [...handlers.keys()];
}

/**
 * 一次 drain 的预算。任一条触顶就停，剩下的留给下一次 tick。
 *
 * 有预算是为了让 tick 可预测地结束：dreaming 在大项目上可能跑几十分钟，没有
 * 上限的话一次 tick 会无限期地占着这个进程。跑不完不丢——任务还在表里。
 */
export const DRAIN_BUDGET_MS = 4 * 60_000;
export const DRAIN_MAX_JOBS = 20;

export type DrainResult = {
  ran: number;
  done: number;
  retry: number;
  failed: number;
  stopped_by: "empty" | "budget" | "max-jobs" | "no-handlers";
};

// 同一个进程里只允许一个 drain 在跑。tick 每小时打一次，上一次没跑完时不该叠加。
// 跨进程（PM2 cluster）靠的是 SKIP LOCKED，不是这个标志。
let draining = false;

async function drainLoop(budgetMs: number, maxJobs: number): Promise<DrainResult> {
  const result: DrainResult = { ran: 0, done: 0, retry: 0, failed: 0, stopped_by: "empty" };
  const types = registeredTypes();
  if (types.length === 0) {
    result.stopped_by = "no-handlers";
    return result;
  }

  const worker = workerId();
  const deadline = Date.now() + budgetMs;

  for (;;) {
    if (result.ran >= maxJobs) { result.stopped_by = "max-jobs"; break; }
    if (Date.now() >= deadline) { result.stopped_by = "budget"; break; }

    const job = await claimNext(worker, types);
    if (!job) { result.stopped_by = "empty"; break; }

    const handler = handlers.get(job.type);
    if (!handler) {
      // 抢的时候按 types 过滤过，正常走不到这里；防的是注册表在两步之间被改动。
      await fail(job.id, new Error(`没有注册 ${job.type} 类型的处理函数`));
      result.ran++; result.failed++;
      continue;
    }

    const outcome = await runJob(job, handler);
    result.ran++;
    if (outcome === "done") result.done++;
    else if (outcome === "retry") result.retry++;
    else result.failed++;
  }

  return result;
}

/** 排空队列，跑到预算用完为止。已有 drain 在跑时直接返回 already-running。 */
export async function drainOnce(
  opts: { budgetMs?: number; maxJobs?: number } = {},
): Promise<DrainResult | "already-running"> {
  if (draining) return "already-running";
  draining = true;
  try {
    return await drainLoop(opts.budgetMs ?? DRAIN_BUDGET_MS, opts.maxJobs ?? DRAIN_MAX_JOBS);
  } finally {
    draining = false;
  }
}

/**
 * 后台排空，立刻返回。tick 端点用它，避免 HTTP 请求被一个几十分钟的任务挂住。
 *
 * 请求返回后 drain 仍在跑——这在常驻的 Node 服务里没问题。万一进程中途挂了，
 * 在跑的任务会被 reclaimStale 回收，这正是 Job 表存在的意义。
 */
export function startBackgroundDrain(
  opts: { budgetMs?: number; maxJobs?: number } = {},
): "started" | "already-running" {
  if (draining) return "already-running";
  void drainOnce(opts).catch(() => {
    // drainLoop 内部逐个任务已经兜过异常，这里防的是 claimNext 自身抛出
    // （数据库断连之类）。吞掉是有意的：没人能接住一个后台 Promise 的 rejection，
    // Node 默认配置下未捕获的 rejection 会直接杀进程。
  });
  return "started";
}
