import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";

const MEMORY_INIT_PROMPT = `你是一位专业的项目文档助手。根据用户提供的参考文件（可能是课程要求、PRD、技术文档等），主动提取和归纳关键信息，生成结构化的项目主文档初稿。

<rules>
1. 仅输出合法的 JSON，不得包含 Markdown、代码块或任何解释性文字。
2. 必须输出 schema 中所有字段；确实没有信息的字段填 null 或 []，不得省略任何字段。
3. 主动归纳：参考文件中有对应信息就提取，确实没有才填 null 或 []。不要因为"没有明确说这是决策"就留空——项目已确定的技术选型、工具、规范都属于 key_decisions。
4. key_decisions：包含参考文件中已明确的技术选型、约束和规范；date 字段：若参考文件明确标注了决策时间则填写（YYYY-MM-DD），否则填 null——不要伪造日期。
5. open_issues：将参考文件中的主要待实现内容、未确定事项提取为初始 open_issues。
6. current_progress：新项目无历史进展，设为 null。
7. members：若参考文件未提及成员，填 []。
8. checklist：将参考文件中所有具体、可单独验证的要求逐条提取，粒度要细。每条必须独立可验证——不能是"实现安全层"这种宽泛表述，要细化到"数据包用 AES-GCM 加密"、"每包 nonce 唯一"、"Test 3 篡改检测截图"这个级别。宁可多条也不合并。
9. 语言与参考文件主导语言保持一致。
</rules>

<schema>
{
  "overview": "string or null — 项目背景与目标，2-3句话",
  "goals": ["string — 可验收的核心交付目标"],
  "members": [{ "name": "string", "role": "string" }],
  "milestones": [{ "date": "YYYY-MM-DD or null", "title": "string", "status": "done | pending" }],
  "current_progress": { "summary": "string", "as_of": "YYYY-MM-DD" } or null,
  "key_decisions": [{ "date": "YYYY-MM-DD or null", "decision": "string", "rationale": "string or null" }],
  "open_issues": [{ "issue": "string", "owner": "string or null" }],
  "risks": [{ "risk": "string", "mitigation": "string or null" }],
  "glossary": [{ "term": "string", "definition": "string" }],
  "checklist": [{ "item": "string — 具体可验证的单条要求，保留关键细节", "status": "done | pending" }]
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

async function generateDocumentFromFiles(referenceFiles: string[], apiKey: string): Promise<unknown> {
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

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "API key required. Please configure your DashScope API key in Settings." },
      { status: 401 },
    );
  }

  let document_draft: unknown;
  try {
    document_draft = await generateDocumentFromFiles(reference_files, apiKey);
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to generate document from reference files", detail: String(e) },
      { status: 502 },
    );
  }

  return NextResponse.json({ project_id: project.id, document_draft });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projects = await prisma.project.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "desc" },
    select: { id: true, name: true, created_at: true },
  });
  return NextResponse.json({ projects });
}
