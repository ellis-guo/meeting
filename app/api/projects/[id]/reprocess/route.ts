import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { callDashScope } from "@/lib/dashscope";
import { extractJSON } from "@/lib/utils";
import { MEMORY_INIT_PROMPT } from "@/lib/prompts";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

  const { id } = await params;

  const project = await prisma.project.findFirst({ where: { id, user_id: userId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const referenceFiles = project.reference_files
    ? decryptJSON<string[]>(project.reference_files)
    : [];

  if (referenceFiles.length === 0) {
    return NextResponse.json({ error: "No reference files to reprocess" }, { status: 400 });
  }

  const fileContent = referenceFiles.join("\n\n---\n\n");

  let document_draft: unknown;
  try {
    const content = await callDashScope(MEMORY_INIT_PROMPT, `项目参考文件：\n\n${fileContent}`, apiKey);
    document_draft = extractJSON(content);
  } catch (e) {
    return NextResponse.json(
      { error: "Failed to generate document from reference files", detail: String(e) },
      { status: 502 },
    );
  }

  return NextResponse.json({ document_draft });
}
