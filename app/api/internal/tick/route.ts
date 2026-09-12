import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { reclaimStale } from "@/lib/jobs";
import { drainOnce, startBackgroundDrain, registeredTypes } from "@/lib/jobRunner";
import { scheduleDreaming } from "@/lib/dreaming";
import { registerJobHandlers } from "@/lib/registerJobs";

// 任务队列的心跳端点，由服务器 crontab 每小时打一次：
//
//   0 * * * *  curl -fsS -X POST http://127.0.0.1:3000/api/internal/tick \
//                -H "X-Internal-Secret: $INTERNAL_TICK_SECRET"
//
// 为什么是外部 cron 而不是进程内的 node-cron：部署用 PM2 cluster，进程内定时器
// 每个 worker 都会触发一遍——4 个 worker 就是 4 倍的 LLM 账单，还会互相写脏
// 索引层（phase7-deploy.md 里 rate limiting 已经因为同样的原因妥协过一次）。
//
// 为什么每小时而不是每天 1 点：cron 只能按服务器时间，而 dreaming 要按**用户
// 当地时间**凌晨 1 点。每小时打一次，由 scheduleDreaming 自己筛谁到点了。
// 现在用户都在同一个时区，定成 `0 1 * * *` 也能跑；写成每小时是为了以后加时区
// 不用动架构。
//
// 鉴权：机器调用没有 Clerk session，所以 proxy.ts 放行了 /api/internal/*，改由
// 这里的共享密钥把关。**密钥没配就一律 503**——绝不能因为环境变量缺失，让它
// 退化成一个谁都能打的任务触发入口。生产环境建议再让 nginx 只对 127.0.0.1 开放。

function secretOk(req: NextRequest, expected: string): boolean {
  const got = req.headers.get("x-internal-secret") ?? "";
  // 先哈希再比：timingSafeEqual 要求等长，直接比会因为长度不同抛异常，
  // 而"先比长度再比内容"又把密钥长度泄露出去了。摘要总是 32 字节。
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(got), digest(expected));
}

function guard(req: NextRequest): NextResponse | null {
  const expected = process.env.INTERNAL_TICK_SECRET ?? "";
  if (!expected) {
    return NextResponse.json(
      { error: "INTERNAL_TICK_SECRET 未配置，内部端点已禁用" },
      { status: 503 },
    );
  }
  if (!secretOk(req, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function queueStats() {
  const rows = await prisma.job.groupBy({ by: ["status"], _count: { _all: true } });
  const stats: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r._count._all;
  return stats;
}

/** 只读：看队列现状。用来回答"昨晚到底跑了没"。 */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  registerJobHandlers();

  const [stats, failed, dirty] = await Promise.all([
    queueStats(),
    prisma.job.findMany({
      where: { status: "failed" },
      select: { id: true, type: true, project_id: true, attempts: true, last_error: true, updated_at: true },
      orderBy: { updated_at: "desc" },
      take: 10,
    }),
    prisma.project.count({ where: { index_dirty: true } }),
  ]);

  return NextResponse.json({
    at: new Date().toISOString(),
    handlers: registeredTypes(),
    queue: stats,
    dirty_projects: dirty,
    // 截断：last_error 存的是完整 stack，全量返回会让这个接口没法看
    recent_failures: failed.map((j) => ({ ...j, last_error: j.last_error?.slice(0, 300) ?? null })),
  });
}

/** 一次 tick：回收僵死任务 → 排 dreaming → 排空队列。 */
export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  // 必须在 drain 之前：没注册的类型不会被抢走，漏调的后果是任务原地不动
  registerJobHandlers();

  // ?wait=1 时同步跑完再返回，手动触发和测试用；cron 不该用，会把连接挂住
  const wait = new URL(req.url).searchParams.get("wait") === "1";

  const reclaimed = await reclaimStale();
  const scheduled = await scheduleDreaming();
  const before = await queueStats();

  const drain = wait ? await drainOnce() : startBackgroundDrain();

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    reclaimed,
    scheduled,
    queue_before_drain: before,
    handlers: registeredTypes(),
    drain,
  });
}
