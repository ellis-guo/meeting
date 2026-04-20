import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { getDashScopeKey } from "@/lib/apiKey.server";

async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-v3", input: texts, dimension: 1024 }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} — ${await res.text()}`);
  return ((await res.json()).data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

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

  // Fetch all chunks without embeddings for this project
  const chunks = await prisma.$queryRaw<Array<{ id: string; content: string }>>`
    SELECT id, content FROM "Chunk"
    WHERE project_id = ${projectId} AND embedding IS NULL
  `;

  if (chunks.length === 0) {
    return NextResponse.json({ embedded: 0, failed: 0, message: "所有 chunk 已有向量，无需重新处理" });
  }

  const BATCH = 10;
  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    let vectors: number[][];
    try {
      vectors = await fetchEmbeddings(batch.map((c) => c.content), apiKey);
    } catch {
      failed += batch.length;
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = `[${vectors[j].join(",")}]`;
      try {
        await prisma.$executeRaw`UPDATE "Chunk" SET embedding = ${vec}::vector WHERE id = ${batch[j].id}`;
        embedded++;
      } catch {
        failed++;
      }
    }
  }

  return NextResponse.json({
    embedded,
    failed,
    total: chunks.length,
    message: `向量化完成：${embedded} 成功，${failed} 失败`,
  });
}
