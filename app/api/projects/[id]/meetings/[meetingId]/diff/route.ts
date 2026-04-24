import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";

const MEMORY_DIFF_PROMPT = `你是一位专业的项目文档维护助手，负责根据本次会议摘要，识别项目主文档中需要更新的字段，输出最小化差量建议。

<rules>
1. 输出格式：纯 JSON 对象，第一个字符为 {，最后一个字符为 }，不含任何 Markdown、代码块或解释文字。
2. 仅基于会议摘要中明确提及的内容提出更新；会议未涉及的字段不出现在 updates 中。
3. 极度压缩：所有字段内容保持短语级别，与主文档整体风格一致。
4. 每条更新附 reason，说明依据来自会议的哪部分内容，≤20 字。
5. key_decisions 新增条目的 date 与 current_progress.as_of 必须使用 context 中提供的会议日期（YYYY-MM-DD），不得使用今日日期。
</rules>

<fields>

<field name="key_decisions">
只能新增，不能修改或删除已有条目——主文档决策记录是只增的历史账本，保证决策可追溯。
new 值为完整数组：原有条目原样保留，新条目追加在末尾。
<example>
会议决定改用 Redis 做缓存：
✓ new = [...原有条目, { "date": "2026-04-20", "decision": "改用缓存(Redis)替代内存缓存", "rationale": "高并发下内存缓存命中率低" }]
✗ 修改原有条目 / 删除原有条目
</example>
</field>

<field name="checklist">
仅可将已完成条目的 status 从 "pending" 改为 "done"——checklist 条目由初始文档定义，会议只能标记完成，不新增也不删除。
new 值为完整数组，未完成条目原样保留。
<example>
会议演示了 AES 加密实现：
✓ 将 { "item": "数据传输使用 AES-256-GCM 加密", "status": "pending" } 改为 "done"
✗ 新增条目 / 删除条目
</example>
</field>

<field name="open_issues">
条目永不删除，resolved_at 为 flag：null = 未解决，"YYYY-MM-DD" = 已解决。
新增问题：{ "issue": "...", "owner": null, "opened_at": "<会议日期>", "resolved_at": null }
标记解决：将对应条目的 resolved_at 设为 "<会议日期>"，其余字段不变。
new 值为完整数组，包含所有条目（含已解决）。
</field>

<field name="current_progress">
追加新快照到现有数组，历史条目保留不删除。
new 值为完整数组：[...现有条目, { "summary": "...", "as_of": "<会议日期>" }]
as_of 使用会议日期，不用今日日期。
</field>

<field name="milestones">
可将已完成里程碑的 status 从 "pending" 改为 "done"，或新增会议中确认的新里程碑。
new 值为完整数组。
</field>

<field name="goals / members / glossary / overview">
可根据会议内容新增或更新，new 值为完整新值。
</field>

<field name="next_meeting_goals">
数组格式，每条含时间戳：{ "goal": "string", "set_at": "YYYY-MM-DD", "completed_at": "YYYY-MM-DD | null" }
新增目标：set_at 为会议日期，completed_at 为 null。
完成目标：将对应条目 completed_at 设为会议日期，其余字段不变。
new 值为完整数组，包含所有条目（含已完成）。若会议无相关内容则不更新此字段。
</field>

</fields>

<schema>
{
  "updates": [
    {
      "field": "overview | goals | members | milestones | current_progress | key_decisions | open_issues | glossary | checklist | next_meeting_goals",
      "old": <原值>,
      "new": <新值>,
      "reason": "≤20字，说明依据来自会议哪部分"
    }
  ]
}
</schema>`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start)
    throw new Error("No JSON found");
  return JSON.parse(text.slice(start, end + 1));
}

async function callDashScope(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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
  if (!res.ok)
    throw new Error(`DashScope API error: ${res.status} — ${await res.text()}`);
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
