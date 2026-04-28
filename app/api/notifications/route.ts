import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - RETENTION_MS);

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { user_id: userId, created_at: { gte: since } },
      orderBy: { created_at: "desc" },
      take: 100,
    }),
    prisma.notification.count({
      where: { user_id: userId, created_at: { gte: since }, read: false },
    }),
  ]);

  return NextResponse.json({ items, unread });
}
