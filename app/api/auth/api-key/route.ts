import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { encryptJSON, decryptJSON } from "@/lib/crypto";

const COOKIE_NAME = "ds_key";
const MAX_AGE_S = 60 * 60 * 24;

type StoredKey = { key: string; issuedAt: number; userId: string };

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const key = typeof body.key === "string" ? body.key.trim() : "";

  if (!key || key.length < 10 || key.length > 300) {
    return NextResponse.json({ error: "Invalid API key format" }, { status: 400 });
  }

  const issuedAt = Date.now();
  const encrypted = encryptJSON({ key, issuedAt, userId } satisfies StoredKey);
  const expiresAt = new Date(issuedAt + MAX_AGE_S * 1000).toISOString();

  const res = NextResponse.json({ ok: true, expiresAt });
  res.cookies.set(COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: MAX_AGE_S,
    path: "/",
  });
  return res;
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const encrypted = req.cookies.get(COOKIE_NAME)?.value;
  if (!encrypted) {
    const hasServerKey = !!process.env.DASHSCOPE_API_KEY;
    return NextResponse.json({ configured: hasServerKey, serverProvided: hasServerKey });
  }

  try {
    const { issuedAt, userId: storedUserId } = decryptJSON<StoredKey>(encrypted);
    if (storedUserId && storedUserId !== userId) {
      const res = NextResponse.json({ configured: false });
      res.cookies.delete(COOKIE_NAME);
      return res;
    }
    const expiresAt = new Date(issuedAt + MAX_AGE_S * 1000).toISOString();
    return NextResponse.json({ configured: true, expiresAt });
  } catch {
    const res = NextResponse.json({ configured: false });
    res.cookies.delete(COOKIE_NAME);
    return res;
  }
}

export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_NAME);
  return res;
}
