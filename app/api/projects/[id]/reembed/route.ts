import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { getDashScopeKey } from "@/lib/apiKey.server";
import { decrypt, decryptJSON } from "@/lib/crypto";
import {
  type Summary,
  buildSummaryChunks,
  buildTranscriptChunks,
  embedAndStore,
  buildAndStoreParents,
} from "@/lib/chunking";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = (await getDashScopeKey()) ?? process.env.DASHSCOPE_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "API key required. Please configure your DashScope API key in Settings." },
      { status: 401 },
    );
  }

  const { id: projectId } = await params;
  const project = await prisma.project.findFirst({ where: { id: projectId, user_id: userId } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const meetings = await prisma.meeting.findMany({
    where: { project_id: projectId, user_id: userId },
    select: { id: true, transcript: true, summary: true },
  });

  if (meetings.length === 0) {
    return NextResponse.json({ message: "该项目暂无会议记录", meetings_processed: 0, chunks_created: 0 });
  }

  let totalChunks = 0;
  let meetingsProcessed = 0;

  for (const meeting of meetings) {
    // 1. 清旧数据
    await prisma.$executeRaw`DELETE FROM "ChunkParent" WHERE meeting_id = ${meeting.id}`;
    await prisma.chunk.deleteMany({ where: { meeting_id: meeting.id } });

    // 2. 解密摘要
    let summary: Summary;
    try {
      summary = decryptJSON<Summary>(meeting.summary);
    } catch {
      continue;
    }

    // 3. 重建 summary chunks
    const summaryChunks = buildSummaryChunks(summary, meeting.id, projectId);

    // 4. 重建 transcript chunks（speaker-turn 格式）
    let transcriptText = "";
    try {
      transcriptText = decrypt(meeting.transcript);
    } catch { /* skip transcript if decrypt fails */ }

    const { chunks: transcriptChunks, matchedLines, totalLines } = buildTranscriptChunks(
      transcriptText,
      meeting.id,
      projectId,
      summary.meta.date ?? undefined,
    );

    const formatOk = totalLines === 0 || matchedLines / totalLines >= 0.3;
    const chunksToInsert = formatOk ? [...summaryChunks, ...transcriptChunks] : summaryChunks;

    // 5. 写入 DB
    const created = await Promise.all(
      chunksToInsert.map((c) =>
        prisma.chunk.create({
          data: {
            meeting_id: c.meeting_id,
            project_id: c.project_id,
            chunk_type: c.chunk_type,
            content: c.content,
            search_text: c.search_text,
            section_title: c.section_title,
            speaker: c.speaker,
            line_start: c.line_start,
            line_end: c.line_end,
            meeting_date: c.meeting_date,
          },
        }),
      ),
    );

    const chunksWithIds = created.map((c, i) => ({ ...chunksToInsert[i], id: c.id }));
    totalChunks += created.length;

    // 6. Embed
    await embedAndStore(chunksWithIds, meeting.id, apiKey);

    // 7. 重建 parents（仅 transcript）
    if (formatOk) {
      const transcriptWithIds = chunksWithIds.filter((c) => c.chunk_type === "transcript");
      if (transcriptWithIds.length > 0) {
        await buildAndStoreParents(transcriptWithIds);
      }
    }

    meetingsProcessed++;
  }

  return NextResponse.json({
    message: `重新切块完成：处理 ${meetingsProcessed} 个会议，共创建 ${totalChunks} 个 chunk`,
    meetings_processed: meetingsProcessed,
    chunks_created: totalChunks,
  });
}
