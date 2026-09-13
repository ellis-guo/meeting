import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encryptJSON, decryptJSON } from "@/lib/crypto";
import { type Summary } from "@/lib/chunking";
import { markIndexDirty } from "@/lib/dreaming";
import { deleteMeetingCascade } from "@/lib/cascade";
import { enqueue } from "@/lib/jobs";
import { startBackgroundDrain } from "@/lib/jobRunner";
import { registerJobHandlers } from "@/lib/registerJobs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({
    where: { id, user_id: userId },
    select: {
      id: true,
      created_at: true,
      transcript: true,
      summary: true,
      project_id: true,
      processing_status: true,
      diff_status: true,
      document_diff: true,
    },
  });

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...meeting,
    transcript: decrypt(meeting.transcript),
    summary: decryptJSON(meeting.summary),
    document_diff: meeting.document_diff ? decryptJSON(meeting.document_diff) : null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { summary } = await req.json();

  if (!summary || typeof summary !== "object") {
    return NextResponse.json({ error: "summary is required" }, { status: 400 });
  }
  const typed = summary as Summary;
  if (!typed.meta || !Array.isArray(typed.sections)) {
    return NextResponse.json(
      { error: "summary 必须包含 meta 与 sections" },
      { status: 400 },
    );
  }
  if (typed.meta.date !== null && typed.meta.date !== undefined) {
    if (typeof typed.meta.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(typed.meta.date)) {
      return NextResponse.json(
        { error: `会议日期必须是 YYYY-MM-DD，收到：${typed.meta.date}` },
        { status: 400 },
      );
    }
  }

  const meeting = await prisma.meeting.findFirst({ where: { id, user_id: userId } });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  await prisma.meeting.update({
    where: { id },
    data: { summary: encryptJSON(typed) },
  });

  // 用户改了摘要 → 索引层过期。注意这里只标脏不重算：跨会议的实体归一、术语表、
  // 时间轴矛盾都必须看到全量语料才能算，那是 dreaming 的活。本会议自己的
  // embedding 则在下面立刻重建——只看单条的立即做，要看全局的留给夜里。
  await markIndexDirty(meeting.project_id);

  // 摘要变了，检索索引也得跟着变。走任务队列，不再是裸 fire-and-forget——
  // 原来那种写法进程一重启就静默消失，chunk 留在库里却没有向量，而所有向量
  // 检索都带 `embedding IS NOT NULL`，结果是**用户改完的内容从此检索不到**，
  // 界面上完全看不出来。
  //
  // 校验基准、解密、删旧建新全在处理函数里（lib/reindexHandler.ts），
  // 这里只负责把事情记下来。
  registerJobHandlers();
  await enqueue({
    userId,
    projectId: meeting.project_id,
    type: "reindex",
    payload: { meetingId: id, mode: "summary" },
  });
  startBackgroundDrain();

  return NextResponse.json({ id, summary: typed });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const meeting = await prisma.meeting.findFirst({ where: { id, user_id: userId } });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  await deleteMeetingCascade(id, userId);

  return NextResponse.json({ ok: true });
}
