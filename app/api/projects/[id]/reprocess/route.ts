import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";

function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No valid JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

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

// POST /api/projects/:id/reprocess — 重新处理参考文件，返回新草稿
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const referenceFiles = project.reference_files
    ? decryptJSON<string[]>(project.reference_files)
    : [];

  if (referenceFiles.length === 0) {
    return NextResponse.json(
      { error: "No reference files to reprocess" },
      { status: 400 },
    );
  }

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
    const err = await res.text();
    return NextResponse.json(
      { error: `DashScope API error: ${res.status}`, detail: err },
      { status: 502 },
    );
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return NextResponse.json({ error: "Empty response from model" }, { status: 502 });
  }

  let document_draft: unknown;
  try {
    document_draft = extractJSON(content);
  } catch {
    return NextResponse.json(
      { error: "Failed to parse model response as JSON", raw: content },
      { status: 502 },
    );
  }

  return NextResponse.json({ document_draft });
}
