import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const project = await prisma.project.findFirst({
    where: { id, user_id: userId },
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

  return NextResponse.json({
    ...project,
    document: project.document ? decryptJSON(project.document) : {},
    reference_files: project.reference_files ? decryptJSON(project.reference_files) : [],
    meetings: project.meetings.map((m) => ({
      ...m,
      summary: m.summary ? decryptJSON(m.summary) : null,
    })),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const project = await prisma.project.findFirst({ where: { id, user_id: userId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const meetings = await prisma.meeting.findMany({ where: { project_id: id }, select: { id: true } });
  const meetingIds = meetings.map((m) => m.id);

  await prisma.chunk.deleteMany({ where: { meeting_id: { in: meetingIds } } });
  await prisma.meeting.deleteMany({ where: { project_id: id } });
  await prisma.project.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
