import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encrypt, encryptJSON, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { checkRateLimit } from "@/lib/ratelimit";
import { getLangRule } from "@/lib/lang";
import { enqueue } from "@/lib/jobs";
import { startBackgroundDrain } from "@/lib/jobRunner";
import { registerJobHandlers } from "@/lib/registerJobs";

// ── GET: list standalone meetings ─────────────────────────────────────────────
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const meetings = await prisma.meeting.findMany({
    where: { user_id: userId, project_id: null },
    select: { id: true, created_at: true, summary: true },
    orderBy: { created_at: "desc" },
    take: 20,
  });

  return NextResponse.json({
    meetings: meetings.map((m) => {
      let date: string | null = null;
      try { date = (decryptJSON<{ meta?: { date?: string | null } }>(m.summary))?.meta?.date ?? null; } catch { /* ignore */ }
      return { id: m.id, created_at: m.created_at, date };
    }),
  });
}

// ── POST: 收下逐字稿，排队，立刻返回 ──────────────────────────────────────────
//
// 原来这里是一条 SSE：用户提交后必须**等在页面上**看着摘要一个字一个字生成，
// 中途关掉页面这次就白提交了，进程重启同理。PRD 4.2 要的是反过来——
//
//     上传 → 建任务 → 立即返回「正在录入 XX 项目」
//                        ↓（后台）
//                  生成会议记录 → 通知「记录好啦，可以查看或修改」
//
// 代价是没有了逐字流式的观感；换来的是关掉页面照样跑完、崩了能被 reclaimStale
// 捡回来重试、失败有 Job 行可查而不是一句 toast 就没了。
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkRateLimit(userId, "POST:/api/meeting");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试（每分钟最多 5 次）" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  // 生成本身走服务端 key（后台任务读不到 cookie），但这里仍然校验一次：
  // 没配 key 就当场告诉用户，而不是让他等一个注定失败的后台任务。
  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "API key required. Please configure your DashScope API key in Settings." },
      { status: 401 },
    );
  }

  const { transcript, template = "smart", date, time, project_id } = await req.json();
  if (!transcript?.trim()) return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  if (transcript.length > 200_000) return NextResponse.json({ error: "transcript too large (max 200KB)" }, { status: 400 });

  let projectName: string | null = null;
  if (project_id) {
    const owned = await prisma.project.findFirst({
      where: { id: project_id, user_id: userId },
      select: { id: true, name: true },
    });
    if (!owned) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    projectName = owned.name;
  }

  // 先落库再排队：任务 payload 里只带 meetingId，逐字稿留在 Meeting 行上。
  // 反过来（逐字稿塞进 payload）的话，一份 200KB 的逐字稿要被加密两份，而且
  // 重试读的是任务里那份快照，跟表里的可能已经对不上。
  const meeting = await prisma.meeting.create({
    data: {
      user_id: userId,
      transcript: encrypt(transcript),
      // 摘要还没有。存一个合法的空壳而不是空串：读的地方一律 decryptJSON 后直接
      // 取 meta.date，空串会抛、空对象会 undefined。
      summary: encryptJSON({
        meta: { date: date ?? null, time: time ?? null, participants: [] },
        sections: [],
      }),
      project_id: project_id ?? null,
      processing_status: "pending",
    },
    select: { id: true },
  });

  registerJobHandlers();
  await enqueue({
    userId,
    projectId: project_id ?? null,
    type: "summarize",
    payload: {
      meetingId: meeting.id,
      template: template === "project" ? "project" : "smart",
      // 输出语言规则读的是请求头，后台任务拿不到，必须随任务带过去
      langRule: getLangRule(req),
      date: date ?? null,
      time: time ?? null,
    },
  });
  // 立刻在后台开跑，不等下一次 tick
  startBackgroundDrain();

  return NextResponse.json(
    {
      meeting_id: meeting.id,
      status: "pending",
      message: projectName ? `正在录入「${projectName}」` : "正在录入这次会议",
    },
    { status: 202 },
  );
}
