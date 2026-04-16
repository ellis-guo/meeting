import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: { id: true, created_at: true, transcript: true, summary: true, project_id: true },
  });

  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  return NextResponse.json(meeting);
}

// PATCH /api/meetings/:id — 更新摘要
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { summary } = await req.json();

  if (!summary || typeof summary !== "object") {
    return NextResponse.json({ error: "summary is required" }, { status: 400 });
  }

  const meeting = await prisma.meeting.findUnique({ where: { id } });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const updated = await prisma.meeting.update({
    where: { id },
    data: { summary: summary as object },
  });

  return NextResponse.json(updated);
}

// DELETE /api/meetings/:id — 删除会议
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const meeting = await prisma.meeting.findUnique({ where: { id } });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  await prisma.chunk.deleteMany({ where: { meeting_id: id } });
  await prisma.meeting.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
