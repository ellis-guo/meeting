import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { decryptJSON } from "./crypto";

const COOKIE_NAME = "ds_key";

type StoredKey = { key: string; issuedAt: number; userId?: string };

export async function getDashScopeKey(): Promise<string | null> {
  const { userId } = await auth();
  const cookieStore = await cookies();
  const encrypted = cookieStore.get(COOKIE_NAME)?.value;
  if (encrypted) {
    try {
      const { key, userId: storedUserId } = decryptJSON<StoredKey>(encrypted);
      if (!storedUserId || storedUserId === userId) return key ?? null;
    } catch {
      // fall through to server key
    }
  }
  return process.env.DASHSCOPE_API_KEY ?? null;
}
