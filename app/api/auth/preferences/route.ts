import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

const COOKIE_NAME = "lang_pref";
const VALID_LANGS = ["zh", "en"] as const;
type Lang = (typeof VALID_LANGS)[number];

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lang = req.cookies.get(COOKIE_NAME)?.value ?? "zh";
  return NextResponse.json({ lang });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { lang } = await req.json();
  if (!VALID_LANGS.includes(lang as Lang)) {
    return NextResponse.json({ error: "Invalid lang. Must be 'zh' or 'en'." }, { status: 400 });
  }

  const res = NextResponse.json({ lang });
  res.cookies.set(COOKIE_NAME, lang as string, {
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
    sameSite: "lax",
    httpOnly: false,
  });
  return res;
}
