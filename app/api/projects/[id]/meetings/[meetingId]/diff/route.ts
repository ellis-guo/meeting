import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { callDashScope } from "@/lib/dashscope";
import { extractJSON } from "@/lib/utils";
import { MEMORY_DIFF_PROMPT } from "@/lib/prompts";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; meetingId: string }> },
) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const lang = _req.cookies.get("lang_pref")?.value ?? "zh";
  const langRule =
    lang === "en"
      ? "Output language: English. Retain original form for technical terms and proper nouns."
      : "输出语言：以中文为主，学术名词、专有名词、代码标识符保留英文原文。";

  let diffContent: string;
  try {
    diffContent = await callDashScope(
      MEMORY_DIFF_PROMPT,
      `${langRule}\n\n会议日期：${meetingDate}\n\n当前项目主文档：\n${JSON.stringify(projectDocument, null, 2)}\n\n本次会议摘要：\n${JSON.stringify(summary, null, 2)}\n\n请输出需要更新的字段及建议内容。`,
      apiKey,
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  let document_diff: unknown;
  try {
    document_diff = extractJSON(diffContent);
  } catch {
    document_diff = { updates: [] };
  }

  return NextResponse.json({
    document_diff,
    project_document: projectDocument,
  });
}
