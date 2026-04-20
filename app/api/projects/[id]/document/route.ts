import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { encryptJSON, decryptJSON } from "@/lib/crypto";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { document: newDoc } = await req.json();

  if (!newDoc || typeof newDoc !== "object") {
    return NextResponse.json({ error: "document is required" }, { status: 400 });
  }

  const project = await prisma.project.findFirst({ where: { id, user_id: userId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const oldDoc = (project.document ? decryptJSON<Record<string, unknown>>(project.document) : {}) as Record<string, unknown>;
  const oldDecisions = Array.isArray(oldDoc?.key_decisions) ? oldDoc.key_decisions : [];
  const newDecisions = Array.isArray(newDoc?.key_decisions) ? newDoc.key_decisions : [];

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  for (const decision of newDecisions.slice(oldDecisions.length)) {
    const d = (decision as Record<string, unknown>).date;
    if (d !== null && (typeof d !== "string" || !dateRegex.test(d))) {
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
