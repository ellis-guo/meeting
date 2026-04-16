import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addLineNumbers } from "@/lib/utils";

const RULES = `规则：
1. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。
2. 仅记录会议中明确陈述或决定的内容，不推断态度、情绪或人物性格，禁止出现评判性表述，例如"X缺乏自信"或"此问题暴露了沟通不畅"。
3. source_lines 必须引用原文中真实存在的行号，禁止虚构；每一条内容都必须附带 source_lines，不得为空数组。
4. 检测会议记录的主导语言，所有摘要文本使用该语言输出。若会议为多语言混合，以主导语言为准，但保留原文中出现的专业术语、学术词汇及专有名词。
5. 表达简洁规范，避免口语化或冗长表述，使用正式书面语。
6. 所有文本字段优先使用短语，而非完整句子。`;

const CONTENT_TYPE_GUIDE = `内容类型说明 — 根据每个章节的内容选择最合适的类型：
- "text"：单段落或单条陈述（如会议概述、简短结论）
- "bullets"：多个独立要点。每条 bullet 可选包含 sub_items 用于嵌套细节。
- "table"：当内容具有清晰统一的列结构时使用（如 负责人 / 任务 / 截止日期）。仅当所有行共享相同列结构时才使用 table。

重要：sub_items 为可选字段。当一个要点包含多个独立子内容时使用，禁止用分号将其合并为一条。

各类型 Schema：
  { "type": "text", "value": "string", "source_lines": [number] }
  { "type": "bullets", "items": [{ "text": "string", "source_lines": [number], "sub_items": [{ "text": "string", "source_lines": [number] }] }] }
  { "type": "table", "columns": ["string"], "rows": [{ "cells": ["string"], "source_lines": [number] }] }`;

const SHARED_SCHEMA = `输出 Schema：
{
  "meta": {
    "date": "string or null",
    "time": "string or null",
    "participants": ["string"]
  },
  "sections": [
    {
      "title": "string",
      "content": <以上三种内容类型之一>
    }
  ],
  "humanistic_note": "string or null"
}`;

const SUMMARY_SMART_PROMPT = `你是一位专业的会议记录助手，擅长从口语化的会议记录中提炼关键信息，以结构化、正式书面语的方式输出会议摘要。

${RULES}

${CONTENT_TYPE_GUIDE}

${SHARED_SCHEMA}

输出指引：
- meta.date：从会议记录或上下文中提取日期，若未提及则为 null
- meta.time：从会议记录中提取会议开始时间，若未提及则为 null
- meta.participants：提取会议记录中出现的所有发言者姓名
- sections：自行决定章节数量、标题及最合适的内容类型，完整呈现会议讨论内容
- 讨论内容是摘要的核心，每个议题须完整呈现各方观点及结论；若会议中讨论篇幅远多于分工安排，摘要的详细程度应与之成比例
- humanistic_note：仅当会议中有人明确、反复提到身体不适（生病、头疼、发烧等）或明显沮丧（想哭、很难过、崩溃等）时触发，门槛要高，模糊信号一律返回 null。触发时用一句15字以内的话表达简单关心或祝福；绝对不提情绪本身、不做任何情绪分析、不贴标签；否则为 null。
  示例：
  - "（触发：生病）Ellis，好好休息，早日康复！"
  - "（触发：沮丧）李总，加油，祝顺利。"`;

const SUMMARY_PROGRESS_PROMPT = `你是一位专业的会议记录助手，擅长从口语化的项目进度会议记录中提炼关键信息，以结构化、正式书面语的方式输出会议摘要。

${RULES}

${CONTENT_TYPE_GUIDE}

${SHARED_SCHEMA}

输出指引：
- meta.date：从会议记录或上下文中提取日期，若未提及则为 null
- meta.time：从会议记录中提取会议开始时间，若未提及则为 null
- meta.participants：提取会议记录中出现的所有发言者姓名
- sections：须包含以下章节（确实不适用时可跳过）：
    1. 会议概述 — "text" 类型；一段简短概括
    2. 议题详情 — 最重要的章节；涵盖每个讨论议题的完整细节；用 sub_items 拆解多要点议题；禁止用分号合并独立要点
    3. 行动项 — 若所有条目具有统一的负责人/任务结构则用 "table"，否则用 "bullets"；任务描述保持简洁
    4. 下次会议 — "text" 类型；仅在会议中提及时包含
    5. 其他 — "text" 类型；仅在有其他内容时包含
  如有必要可增加额外章节。
- 议题详情 应为摘要中最长、最详细的章节
- humanistic_note：仅当会议中有人明确、反复提到身体不适（生病、头疼、发烧等）或明显沮丧（想哭、很难过、崩溃等）时触发，门槛要高，模糊信号一律返回 null。触发时用一句15字以内的话表达简单关心或祝福；绝对不提情绪本身、不做任何情绪分析、不贴标签；否则为 null。
  示例：
  - "（触发：生病）Ellis，好好休息，早日康复！"
  - "（触发：沮丧）李总，加油，祝顺利。"`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No valid JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

const MEMORY_DIFF_PROMPT = `你是一位专业的项目文档维护助手。根据本次会议摘要，分析项目主文档中哪些内容需要更新，输出差量更新建议。

规则：
1. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。
2. 仅基于本次会议摘要中明确提及的内容提出更新建议，不推断。
3. key_decisions 只能新增，不能修改或删除已有条目。
4. 若本次会议无需更新某字段，不要在 updates 中包含该字段。
5. 每条建议须附带 reason，说明依据来自会议的哪部分内容。
6. key_decisions 新增条目的 date 字段必须使用绝对日期格式（YYYY-MM-DD），禁止使用"今天"、"本次会议"、"上周"等相对时间表达。

输出 Schema：
{
  "updates": [
    {
      "field": "current_progress | key_decisions | open_issues | next_meeting_goals",
      "old": "string or array",
      "new": "string or array",
      "reason": "string"
    }
  ]
}`;

async function callDashScope(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DashScope API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return content;
}

export async function POST(req: NextRequest) {
  const {
    transcript,
    template = "smart",
    date,
    time,
    project_id,
  } = await req.json();

  if (!transcript?.trim()) {
    return NextResponse.json(
      { error: "transcript is required" },
      { status: 400 },
    );
  }

  // If project_id provided, verify project exists
  let project: { id: string; document: unknown } | null = null;
  if (project_id) {
    project = await prisma.project.findUnique({ where: { id: project_id } });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
  }

  const numbered = addLineNumbers(transcript);
  const systemPrompt =
    template === "project" ? SUMMARY_PROGRESS_PROMPT : SUMMARY_SMART_PROMPT;

  const contextLines = [
    date ? `Meeting date: ${date}` : null,
    time ? `Meeting time: ${time}` : null,
    `以下是会议记录：\n\n${numbered}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Step 1: Generate meeting summary
  let summaryContent: string;
  try {
    summaryContent = await callDashScope(systemPrompt, contextLines);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  let summary: unknown;
  try {
    summary = extractJSON(summaryContent);
  } catch {
    return NextResponse.json(
      { error: "Failed to parse summary as JSON", raw: summaryContent },
      { status: 502 },
    );
  }

  // Save meeting to DB
  const today = new Date().toISOString().slice(0, 10);
  const meeting = await prisma.meeting.create({
    data: {
      transcript,
      summary: summary as object,
      project_id: project_id ?? null,
    },
  });

  // Step 2 (serial): If project_id, generate document diff with Prompt B
  if (project) {
    const userMessage = `当前日期：${today}

当前项目主文档：
${JSON.stringify(project.document, null, 2)}

本次会议摘要：
${JSON.stringify(summary, null, 2)}

请输出需要更新的字段及建议内容。`;

    let diffContent: string;
    try {
      diffContent = await callDashScope(MEMORY_DIFF_PROMPT, userMessage);
    } catch (e) {
      // Don't fail the whole request if diff generation fails
      return NextResponse.json({
        numbered_transcript: numbered,
        summary,
        meeting_id: meeting.id,
        document_diff: null,
        document_diff_error: String(e),
      });
    }

    let document_diff: unknown;
    try {
      document_diff = extractJSON(diffContent);
    } catch {
      document_diff = null;
    }

    return NextResponse.json({
      numbered_transcript: numbered,
      summary,
      meeting_id: meeting.id,
      document_diff,
    });
  }

  return NextResponse.json({
    numbered_transcript: numbered,
    summary,
    meeting_id: meeting.id,
  });
}
