import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";

const MEMORY_INIT_PROMPT = `你是一位专业的项目文档助手，负责从参考文件中提取结构化信息，生成项目主文档初稿。核心目的是方便浏览者快速了解项目目标、人员、时间线(完成进度/里程碑)，并单独记录实现细节的，供检查遗漏用。你收到的参考文件可能是课程要求、PRD、技术规范或设计文档等综合的文件。

<rules>
1. 输出格式：纯 JSON 对象，第一个字符为 {，最后一个字符为 }，不含任何 Markdown、代码块或解释文字。
2. 字段完整性：输出 schema 中全部字段；没有对应信息的字段填 null 或 []，不得省略。
3. 主动归纳：只要参考文件有对应信息就提取。技术选型、工具约束、规范要求不需要被明确标注为"决策"——已选定的就是决策。
4. 语言：以中文为主；专有名词、技术术语统一格式为 中文名称(英文原文)，如"向量数据库(pgvector)"、"加密算法(AES-256-GCM)"；无中文对应时保留英文原文。
</rules>

<fields>

<field name="overview">
(项目概述，清晰传达项目核心)项目是什么，面向谁，需要完成什么？一般3句话。
注意：在需要完成什么部分，overview 更关注整体要完成什么，goals 则按时间顺序描述每个阶段可验收的交付目标，goals可以认为是overview的细分；参考文件无背景信息时填 null。
</field>

<field name="goals">
（核心目标）模块级可验收交付目标，每条用动宾结构。
<example>
✓ "实现用户注册与登录"
✓ "支持会议记录上传与解析"
✗ "使用 AES-256-GCM 加密数据包"（实现级，属于 checklist）
</example>
</field>

<field name="members">
（成员）name 为真实姓名或花名，role 为职能描述。参考文件未提及成员时填 []。
</field>

<field name="milestones">
（里程碑，能够把整个项目串起来）date 任务有明确截止日期填 YYYY-MM-DD 否则 null；title 为简短短语；status 根据参考文件判断，默认 pending。
</field>

<field name="current_progress">
（当前进度）你正在进行项目初始化，这部分固定填 null，无需归纳。
</field>

<field name="key_decisions">
（关键决策）你正在进行项目初始化，这部分固定填 null，无需归纳。
</field>

<field name="open_issues">
（待解决问题）你正在进行项目初始化，这部分固定填 null，无需归纳。
</field>

<field name="glossary">
（术语表）项目专有名词、缩写、行话。term 可保留英文原文；definition 为中文解释。参考文件无术语时填 []。
</field>

<field name="checklist">
（checklist，用于后期检查是否有要求细节遗漏）参考文件中所有具体、可单独验证的实现级要求，逐条提取，宁可多条也不合并，每条 status 默认 pending。
粒度标准：每条一句话能描述清楚验收条件。
<example>
✗ "实现数据加密"（太宽泛，无法独立验收）
✓ "数据传输使用 AES-256-GCM(AES-256-GCM) 加密"
✓ "每个数据包 nonce 唯一，不重复使用"
✓ "提交 Test 3 篡改检测截图"
</example>
</field>

</fields>

<schema>
{
  "overview": "string or null",
  "goals": ["string"],
  "members": [{ "name": "string", "role": "string" }],
  "milestones": [{ "date": "YYYY-MM-DD or null", "title": "string", "status": "done | pending" }],
  "current_progress": null,
  "key_decisions": [],
  "open_issues": [],
  "glossary": [{ "term": "string", "definition": "string" }],
  "checklist": [{ "item": "string", "status": "done | pending" }]
}
</schema>`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No valid JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function generateDocumentFromFiles(
  referenceFiles: string[],
  apiKey: string,
  langRule: string,
): Promise<unknown> {
  const fileContent = referenceFiles.join("\n\n---\n\n");

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
          { role: "system", content: MEMORY_INIT_PROMPT },
          {
            role: "user",
            content: `${langRule}\n\n项目参考文件：\n\n${fileContent}`,
          },
        ],
        enable_thinking: false,
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`DashScope API error: ${res.status}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");

  return extractJSON(content);
}

function getLangRule(req: NextRequest): string {
  const lang = req.cookies.get("lang_pref")?.value ?? "zh";
  return lang === "en"
    ? "Output language: English. Retain original form for technical terms and proper nouns."
    : "输出语言：以中文为主，学术名词、专有名词、代码标识符保留英文原文。";
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const langRule = getLangRule(req);
  const { name, reference_files = [] } = await req.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      user_id: userId,
      name: name.trim(),
      reference_files: encryptJSON(reference_files),
      document: encryptJSON({}),
    },
  });

  if (reference_files.length === 0) {
    return NextResponse.json({ project_id: project.id, document_draft: null });
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

  let document_draft: unknown;
  try {
    document_draft = await generateDocumentFromFiles(
      reference_files,
      apiKey,
      langRule,
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: "Failed to generate document from reference files",
        detail: String(e),
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ project_id: project.id, document_draft });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projects = await prisma.project.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "desc" },
    select: { id: true, name: true, created_at: true },
  });
  return NextResponse.json({ projects });
}
