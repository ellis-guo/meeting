import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON, encryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { callDashScope } from "@/lib/dashscope";
import { extractJSON } from "@/lib/utils";
import { MEMORY_DIFF_PROMPT } from "@/lib/prompts";
import { validateDiff } from "@/lib/projectDocSchema";
import { getLangRule } from "@/lib/lang";
import { checkRateLimit } from "@/lib/ratelimit";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; meetingId: string }> },
) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkRateLimit(userId, "POST:/api/projects/diff");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const apiKey =
    (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "API key required. Please configure your DashScope API key in Settings.",
      },
      { status: 401 },
    );
  }

  const { id: projectId, meetingId } = await params;

  const [project, meeting] = await Promise.all([
    prisma.project.findFirst({ where: { id: projectId, user_id: userId } }),
    prisma.meeting.findFirst({
      where: { id: meetingId, project_id: projectId, user_id: userId },
    }),
  ]);

  if (!project)
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!meeting)
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

  const projectDocument = project.document ? decryptJSON(project.document) : {};
  const summary = meeting.summary
    ? decryptJSON<{ meta?: { date?: string | null } }>(meeting.summary)
    : {};
  const meetingDate =
    (summary as { meta?: { date?: string | null } })?.meta?.date ??
    new Date().toISOString().slice(0, 10);

  const langRule = getLangRule(req);

  let diffContent: string;
  try {
    diffContent = (await callDashScope(
      MEMORY_DIFF_PROMPT,
      `${langRule}\n\n会议日期：${meetingDate}\n\n当前项目主文档：\n${JSON.stringify(projectDocument, null, 2)}\n\n本次会议摘要：\n${JSON.stringify(summary, null, 2)}\n\n请输出需要更新的字段及建议内容。`,
      apiKey,
    )).content;
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  // 解析/校验失败必须显式报错。以前这里静默降级成 { updates: [] }，
  // 前端会显示“本次会议无需更新主文档”，用户根本不知道是模型输出坏了。
  let document_diff: unknown;
  try {
    document_diff = extractJSON(diffContent);
  } catch {
    return NextResponse.json(
      { error: "模型返回的更新建议不是合法 JSON，请重试" },
      { status: 502 },
    );
  }
  const schemaError = validateDiff(document_diff);
  if (schemaError) {
    return NextResponse.json(
      { error: `模型返回的更新建议结构有误：${schemaError}` },
      { status: 502 },
    );
  }

  // 落库。手动触发的 diff 以前只走 HTTP 响应回前端内存，刷新即丢——
  // 正是 Phase 9 要消灭的问题。有实际更新时才置 pending，避免空 diff 卡住项目问答。
  const updates = (document_diff as { updates: unknown[] }).updates;
  if (updates.length > 0) {
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        document_diff: encryptJSON(document_diff),
        diff_status: "pending",
        processing_status: "done",
      },
    });
  }

  return NextResponse.json({
    document_diff,
    project_document: projectDocument,
  });
}
