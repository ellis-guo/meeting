import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";

const MEMORY_DIFF_PROMPT = `你是一位专业的项目文档维护助手。根据本次会议摘要，分析项目主文档中哪些内容需要更新，输出差量更新建议。

<rules>
1. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。
2. 仅基于本次会议摘要中明确提及的内容提出更新建议，不推断。
3. key_decisions 只能新增，不能修改或删除已有条目。
4. open_issues 可新增（新问题）或移除（已解决问题），new 值为完整的新数组。
5. checklist：仅可将已完成的条目 status 从 "pending" 改为 "done"，不得新增或删除条目；new 值为完整的新数组。
6. 若本次会议无需更新某字段，不要在 updates 中包含该字段。
7. 每条建议须附带 reason，说明依据来自会议的哪部分内容，≤20字。
8. key_decisions 新增条目的 date 以及 current_progress.as_of，必须使用 context 中提供的会议日期，格式 YYYY-MM-DD。
9. 极度压缩：所有字段内容保持短语级别，与主文档整体风格一致。
</rules>

<schema>
{
  "updates": [
    {
      "field": "overview | goals | members | milestones | current_progress | key_decisions | open_issues | risks | glossary | checklist | next_meeting_goals",
      "old": <原值>,
      "new": <新值，current_progress 必须严格为 {"summary":"string","as_of":"YYYY-MM-DD"} 格式，不得添加其他字段>,
      "reason": "string"
    }
  ]
}
</schema>`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON found");
  return JSON.parse(text.slice(start, end + 1));
}

async function callDashScope(systemPrompt: string, userMessage: string, apiKey: string): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        enable_thinking: false,
      }),
    },
  );
  if (!res.ok) throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return content;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; meetingId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "API key required. Please configure your DashScope API key in Settings." },
      { status: 401 },
    );
  }

  const { id: projectId, meetingId } = await params;

  const [project, meeting] = await Promise.all([
    prisma.project.findFirst({ where: { id: projectId, user_id: userId } }),
    prisma.meeting.findFirst({ where: { id: meetingId, project_id: projectId, user_id: userId } }),
  ]);

  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!meeting) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });

  const projectDocument = project.document ? decryptJSON(project.document) : {};
  const summary = meeting.summary ? decryptJSON<{ meta?: { date?: string | null } }>(meeting.summary) : {};
  const meetingDate = (summary as { meta?: { date?: string | null } })?.meta?.date
    ?? new Date().toISOString().slice(0, 10);

  const lang = _req.cookies.get("lang_pref")?.value ?? "zh";
  const langRule = lang === "en"
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

  return NextResponse.json({ document_diff, project_document: projectDocument });
}
