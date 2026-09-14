import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON } from "@/lib/crypto";
import { checkRateLimit } from "@/lib/ratelimit";

// 建项目不生成任何内容（PRD 5.1）。
//
// 原来这里会把用户粘贴的参考文件喂给模型生成一份主文档初稿，再让用户确认。
// 主文档降级成索引层之后（PRD 4.5）这条路整个没了——文档统一走
// /api/projects/[id]/reference-docs 上传：那条路存原件、能溯源到具体章节、
// 进的是真正被检索的语料池，而不是一份没人看的主文档。

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkRateLimit(userId, "POST:/api/projects");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const { name } = await req.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (name.trim().length > 100) {
    return NextResponse.json({ error: "name too long (max 100)" }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      user_id: userId,
      name: name.trim(),
      // reference_files / document / no_document 三个字段还在表上（存量数据要留着），
      // 但新项目一律建成空的，没有任何流程再写它们。
      reference_files: encryptJSON([]),
      document: encryptJSON({}),
    },
  });

  return NextResponse.json({ project_id: project.id });
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
