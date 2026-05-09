import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { callDashScope } from "@/lib/dashscope";
import { extractJSON } from "@/lib/utils";
import { MEMORY_INIT_PROMPT } from "@/lib/prompts";

async function generateDocumentFromFiles(
  referenceFiles: string[],
  apiKey: string,
  langRule: string,
): Promise<unknown> {
  const fileContent = referenceFiles.join("\n\n---\n\n");
  const content = (await callDashScope(MEMORY_INIT_PROMPT, `${langRule}\n\n项目参考文件：\n\n${fileContent}`, apiKey)).content;
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
  const { name, reference_files = [], no_document = false } = await req.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  if (!Array.isArray(reference_files) || reference_files.length > 10) {
    return NextResponse.json({ error: "reference_files must be an array of at most 10 items" }, { status: 400 });
  }
  for (const f of reference_files) {
    if (typeof f !== "string" || f.length > 100_000) {
      return NextResponse.json({ error: "each reference file must be a string under 100KB" }, { status: 400 });
    }
  }

  const project = await prisma.project.create({
    data: {
      user_id: userId,
      name: name.trim(),
      reference_files: encryptJSON(reference_files),
      document: encryptJSON({}),
      no_document: !!no_document,
    },
  });

  if (no_document || reference_files.length === 0) {
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
  } catch {
    return NextResponse.json(
      { error: "Failed to generate document from reference files" },
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
