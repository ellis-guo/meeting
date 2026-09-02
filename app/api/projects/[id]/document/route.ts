import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON, decryptJSON } from "@/lib/crypto";
import { validateProjectDoc } from "@/lib/projectDocSchema";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { document: newDoc } = await req.json();

  if (!newDoc || typeof newDoc !== "object" || Array.isArray(newDoc)) {
    return NextResponse.json({ error: "document is required" }, { status: 400 });
  }

  // 与 diff/apply 保持同一套校验：这条路径是主文档 JSON 编辑器的写入口，
  // 少一道校验就等于把结构错误的文档直接落库，之后所有渲染和 diff 都会崩。
  const schemaError = validateProjectDoc(newDoc);
  if (schemaError) {
    return NextResponse.json({ error: `主文档格式错误：${schemaError}` }, { status: 400 });
  }

  const project = await prisma.project.findFirst({ where: { id, user_id: userId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const oldDoc = (project.document ? decryptJSON<Record<string, unknown>>(project.document) : {}) as Record<string, unknown>;
  const oldDecisions = Array.isArray(oldDoc?.key_decisions) ? oldDoc.key_decisions : [];
  const newDecisions = Array.isArray(newDoc?.key_decisions) ? newDoc.key_decisions : [];

  // key_decisions 只增不删（全局约束 #4）
  if (newDecisions.length < oldDecisions.length) {
    return NextResponse.json(
      { error: `关键决策只能新增不能删除（原 ${oldDecisions.length} 条，提交 ${newDecisions.length} 条）` },
      { status: 400 },
    );
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  for (const decision of newDecisions.slice(oldDecisions.length)) {
    const d = (decision as Record<string, unknown>).date;
    if (d !== null && d !== undefined && (typeof d !== "string" || !dateRegex.test(d))) {
      return NextResponse.json(
        { error: `key_decisions entry date must be YYYY-MM-DD, got: ${d}` },
        { status: 400 },
      );
    }
  }

  await prisma.project.update({
    where: { id },
    data: { document: encryptJSON(newDoc) },
  });

  return NextResponse.json({ id, document: newDoc });
}
