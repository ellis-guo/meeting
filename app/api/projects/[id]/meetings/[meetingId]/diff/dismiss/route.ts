import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; meetingId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, meetingId } = await params;

  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, project_id: projectId, user_id: userId },
  });
  if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

  // 幂等：无论当前 diff_status 是什么，都置为 dismissed + 清空 document_diff
  await prisma.$transaction([
    prisma.meeting.update({
      where: { id: meetingId },
      data: { document_diff: null, diff_status: "dismissed" },
    }),
    prisma.notification.updateMany({
      where: {
        user_id: userId,
        type: { in: ["diff_pending", "diff_failed"] },
        link: { contains: `/meetings/${meetingId}` },
        read: false,
      },
      data: { read: true },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
