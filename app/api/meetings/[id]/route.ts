import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encryptJSON, decryptJSON } from "@/lib/crypto";

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

  const meeting = await prisma.meeting.findFirst({ where: { id, user_id: userId } });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  await prisma.meeting.update({
    where: { id },
    data: { summary: encryptJSON(summary) },
  });

  return NextResponse.json({ id, summary });
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

  await prisma.chunk.deleteMany({ where: { meeting_id: id } });
  await prisma.meeting.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
