import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const read = typeof body?.read === "boolean" ? body.read : true;

  const notif = await prisma.notification.findFirst({
    where: { id, user_id: userId },
  });
  if (!notif) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.notification.update({ where: { id }, data: { read } });
  return NextResponse.json({ ok: true });
}
