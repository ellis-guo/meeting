import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";

const MEMORY_INIT_PROMPT = `你是一位专业的项目文档助手。根据用户提供的项目参考文件，提取关键信息，生成结构化的项目主文档。

规则：
1. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。
2. 仅记录参考文件中明确陈述的内容，不推断或补充。
3. 若某字段在参考文件中无对应信息，填入 null。
4. 使用正式书面语，与参考文件的主导语言保持一致。

输出 Schema：
{
  "overview": "string or null",
  "current_progress": "string or null",
  "key_decisions": [],
  "open_issues": [],
  "next_meeting_goals": "string or null"
}`;

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No valid JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function generateDocumentFromFiles(referenceFiles: string[]): Promise<unknown> {
  const fileContent = referenceFiles.join("\n\n---\n\n");

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
          { role: "system", content: MEMORY_INIT_PROMPT },
          { role: "user", content: `项目参考文件：\n\n${fileContent}` },
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

// POST /api/projects — 创建项目
export async function POST(req: NextRequest) {
  const { name, reference_files = [] } = await req.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      name: name.trim(),
      reference_files: encryptJSON(reference_files),
      document: encryptJSON({}),
    },
  });

  if (reference_files.length === 0) {
    return NextResponse.json({ project_id: project.id, document_draft: null });
  }

  let document_draft: unknown;
  try {
    document_draft = await generateDocumentFromFiles(reference_files);
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to generate document from reference files", detail: String(e) },
      { status: 502 },
    );
  }

  return NextResponse.json({ project_id: project.id, document_draft });
}

// GET /api/projects — 项目列表
export async function GET() {
  const projects = await prisma.project.findMany({
    orderBy: { created_at: "desc" },
    select: { id: true, name: true, created_at: true },
  });
  return NextResponse.json({ projects });
}
