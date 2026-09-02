import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encryptJSON, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { reindexSummaryChunks, type Summary } from "@/lib/chunking";
import { deleteMeetingCascade } from "@/lib/cascade";

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

  // 摘要变了，检索索引也得跟着变。放后台跑（要调 embedding），失败记 ProcessingLog。
  const apiKey = (await getDashScopeKey()) ?? "";
  if (apiKey) {
    reindexSummaryChunks(id, meeting.project_id, typed, apiKey).catch(async (e) => {
      await prisma.processingLog
        .create({
          data: {
            level: "error",
            meeting_id: id,
            context: encryptJSON({ type: "summary_reindex_failed", detail: String(e) }),
          },
        })
        .catch(() => {});
    });
  }

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
