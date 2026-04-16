import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/projects/:id — 项目详情 + 历史会议列表
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      meetings: {
        orderBy: { created_at: "desc" },
        select: { id: true, created_at: true, summary: true },
      },
    },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project);
}

// DELETE /api/projects/:id — 删除项目（级联删除会议和 chunks）
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // 手动级联：chunks → meetings → project
  const meetings = await prisma.meeting.findMany({ where: { project_id: id }, select: { id: true } });
  const meetingIds = meetings.map((m) => m.id);

  await prisma.chunk.deleteMany({ where: { meeting_id: { in: meetingIds } } });
  await prisma.meeting.deleteMany({ where: { project_id: id } });
  await prisma.project.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
