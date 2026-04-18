import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt, encryptJSON } from "@/lib/crypto";

type ChunkInput = {
  meeting_id: string;
  project_id: string | null;
  chunk_type: string;
  content: string;
  search_text: string | null;
  section_title: null;
  speaker: null;
  line_start: number | null;
  line_end: number | null;
  meeting_date: string | null;
};

function buildFallbackChunks(
  transcript: string,
  meetingId: string,
  projectId: string | null,
): ChunkInput[] {
  const MAX_CHARS = 300;
  const lines = transcript.split("\n");
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
        content: encrypt(text),
        search_text: text,
        section_title: null,
        speaker: null,
        line_start: lineStart,
        line_end: lineEnd,
        meeting_date: null,
      });
    }
    buffer = "";
    lineStart = lineEnd + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    buffer += (buffer ? "\n" : "") + line;

    const endsAtBreak = /[。！？\n]$/.test(line.trimEnd());
    if (buffer.length >= MAX_CHARS && endsAtBreak) {
      flush(i + 1);
    }
  }
  flush(lines.length);

  return chunks;
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const res = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-v3",
        input: texts,
        dimension: 1024,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error: ${res.status} — ${err}`);
  }
  const data = await res.json();
  return (data.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: meetingId } = await params;

  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  // Delete existing transcript chunks for this meeting
  await prisma.chunk.deleteMany({
    where: { meeting_id: meetingId, chunk_type: "transcript" },
  });

  const chunkInputs = buildFallbackChunks(
    decrypt(meeting.transcript),
    meetingId,
    meeting.project_id,
  );

  if (chunkInputs.length === 0) {
    return NextResponse.json({ chunks_created: 0 });
  }

  const created = await Promise.all(
    chunkInputs.map((c) =>
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

  // Embed and store vectors, batch size 10
  const BATCH = 10;
  for (let i = 0; i < created.length; i += BATCH) {
    const batch = created.slice(i, i + BATCH);
    const inputs = chunkInputs.slice(i, i + BATCH);
    const plainTexts = inputs.map((c) => decrypt(c.content));
    let vectors: number[][];
    try {
      vectors = await fetchEmbeddings(plainTexts);
    } catch (e) {
      await prisma.processingLog.create({
        data: {
          level: "error",
          meeting_id: meetingId,
          context: encryptJSON({
            type: "rechunk_embedding_batch_failed",
            batch_start: i,
            detail: String(e),
          }),
        },
      });
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = `[${vectors[j].join(",")}]`;
      try {
        await prisma.$executeRaw`
          UPDATE "Chunk" SET embedding = ${vec}::vector WHERE id = ${batch[j].id}
        `;
      } catch (e) {
        await prisma.processingLog.create({
          data: {
            level: "error",
            meeting_id: meetingId,
            context: encryptJSON({
              type: "rechunk_embedding_write_failed",
              chunk_id: batch[j].id,
              detail: String(e),
            }),
          },
        });
      }
    }
  }

  return NextResponse.json({ chunks_created: created.length });
}
