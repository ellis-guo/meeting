import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON, decryptJSON } from "@/lib/crypto";
import { validateProjectDoc } from "@/lib/projectDocSchema";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; meetingId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, meetingId } = await params;
  const body = await req.json().catch(() => ({}));
  const newDoc = body?.document;
  if (!newDoc || typeof newDoc !== "object") {
    return NextResponse.json({ error: "document is required" }, { status: 400 });
  }

  // Schema 防御校验：拒绝结构错误的文档（防止脏数据落库）
  const schemaError = validateProjectDoc(newDoc);
  if (schemaError) {
    return NextResponse.json({ error: `主文档格式错误：${schemaError}` }, { status: 400 });
  }

  const [project, meeting] = await Promise.all([
    prisma.project.findFirst({ where: { id: projectId, user_id: userId } }),
    prisma.meeting.findFirst({
      where: { id: meetingId, project_id: projectId, user_id: userId },
    }),
  ]);

  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

  // 注：不强制要求 diff_status='pending'。允许用户在以下场景调用：
  //   1) 后台异步生成的 diff（pending 状态） — 正常流程
  //   2) 通过"更新主文档"按钮手动重新生成的 diff（diff_status 可能为 null/confirmed/dismissed）
  //   3) 已 confirmed 的会议再次 apply 一次（幂等）
  // 即使用户什么都没改、newDoc == oldDoc，也按确认处理。

  // key_decisions 只增不删校验（与 PATCH /document 保持一致）
  const oldDoc = (project.document
    ? decryptJSON<Record<string, unknown>>(project.document)
    : {}) as Record<string, unknown>;
  const oldDecisions = Array.isArray(oldDoc.key_decisions) ? oldDoc.key_decisions : [];
  const newDecisions = Array.isArray((newDoc as Record<string, unknown>).key_decisions)
    ? ((newDoc as Record<string, unknown>).key_decisions as unknown[])
    : [];
  if (newDecisions.length < oldDecisions.length) {
    return NextResponse.json({ error: "key_decisions cannot shrink" }, { status: 400 });
  }
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  for (const decision of newDecisions.slice(oldDecisions.length)) {
    const d = (decision as Record<string, unknown>)?.date;
    if (d !== null && d !== undefined && (typeof d !== "string" || !dateRegex.test(d))) {
      return NextResponse.json(
        { error: `key_decisions entry date must be YYYY-MM-DD, got: ${d}` },
        { status: 400 },
      );
    }
  }

  await prisma.$transaction([
    prisma.project.update({
      where: { id: projectId },
      data: { document: encryptJSON(newDoc) },
    }),
    prisma.meeting.update({
      where: { id: meetingId },
      data: { document_diff: null, diff_status: "confirmed" },
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

  return NextResponse.json({ ok: true, document: newDoc });
}
