import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decrypt, decryptJSON } from "@/lib/crypto";
import { getDashScopeKey } from "@/lib/apiKey.server";
import {
  type ChunkInput,
  type Summary,
  insertChunks,
  embedAndStore,
  buildAndStoreParents,
} from "@/lib/chunking";
import { checkRateLimit } from "@/lib/ratelimit";

/**
 * 备用切割：转写稿不是腾讯会议格式（说话人(HH:MM:SS): 内容）时，
 * 按字数 + 句末标点粗切，保证至少有 transcript 索引可用。
 */
function buildFallbackChunks(
  transcript: string,
  meetingId: string,
  projectId: string | null,
  meetingDate: string | null,
): ChunkInput[] {
  const MAX_CHARS = 300;
  // 必须与 addLineNumbers / buildTranscriptChunks 一样过滤空行，
  // 否则这里算出的 line_start/line_end 会比前端显示的行号多算上空行，溯源跳转全部错位。
  const lines = transcript.split("\n").filter((l) => l.trim() !== "");
  const chunks: ChunkInput[] = [];
  let buffer = "";
  let lineStart = 1;

  const flush = (lineEnd: number) => {
    const text = buffer.trim();
    if (text) {
      chunks.push({
        meeting_id: meetingId,
        project_id: projectId,
        chunk_type: "transcript",
        content: text,
        search_text: text,
        section_title: null,
        speaker: null,
        line_start: lineStart,
        line_end: lineEnd,
        meeting_date: meetingDate,
      });
    }
    buffer = "";
    lineStart = lineEnd + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    buffer += (buffer ? "\n" : "") + lines[i];
    if (buffer.length >= MAX_CHARS && /[。！？.!?]$/.test(lines[i].trimEnd())) {
      flush(i + 1);
    }
  }
  flush(lines.length);

  return chunks;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkRateLimit(userId, "POST:/api/meetings/rechunk");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "API key required. Please configure your DashScope API key in Settings." },
      { status: 401 },
    );
  }

  const { id: meetingId } = await params;

  const meeting = await prisma.meeting.findFirst({ where: { id: meetingId, user_id: userId } });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  // 会议日期取自摘要；漏掉它这些 chunk 对所有按日期过滤的检索都是不可见的
  let meetingDate: string | null = null;
  try {
    meetingDate = decryptJSON<Summary>(meeting.summary)?.meta?.date ?? null;
  } catch { /* 摘要解不开就退化为无日期 */ }

  let transcriptText: string;
  try {
    transcriptText = decrypt(meeting.transcript);
  } catch {
    return NextResponse.json({ error: "转写稿解密失败，无法重新切割" }, { status: 500 });
  }

  const chunkInputs = buildFallbackChunks(
    transcriptText,
    meetingId,
    meeting.project_id,
    meetingDate,
  );

  if (chunkInputs.length === 0) {
    return NextResponse.json({ chunks_created: 0 });
  }

  // 旧 transcript chunks 及其 parent 一并清掉，避免新旧混排后 parent_id 指向不存在的行
  await prisma.chunkParent.deleteMany({ where: { meeting_id: meetingId } });
  await prisma.chunk.deleteMany({ where: { meeting_id: meetingId, chunk_type: "transcript" } });

  const created = await insertChunks(chunkInputs);
  await embedAndStore(created, meetingId, apiKey);
  buildAndStoreParents(created).catch(() => {});

  return NextResponse.json({ chunks_created: created.length });
}
