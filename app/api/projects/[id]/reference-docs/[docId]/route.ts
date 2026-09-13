import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { readReferenceFile } from "@/lib/fileStorage";
import { deleteReferenceDocCascade } from "@/lib/cascade";

// 单个参考文件：看抽出来的文本、下载原件、删除。

async function ownedDoc(projectId: string, docId: string, userId: string) {
  // 三个条件都带上：光比 docId 会让别人的文件被"借"项目 id 读到
  return prisma.referenceDoc.findFirst({
    where: { id: docId, project_id: projectId, user_id: userId },
  });
}

/**
 * 下载原件时的 Content-Disposition。
 *
 * 两段式是必须的：`filename=` 只能放 ASCII，中文文件名得走 RFC 5987 的
 * `filename*`；老浏览器读前者，现代浏览器优先读后者。
 *
 * 引号和换行必须去掉——文件名是用户可控的，换行能往响应头里注入新的 header。
 */
function contentDisposition(name: string): string {
  const safe = name.replace(/[\r\n"\\]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, docId } = await params;
  const doc = await ownedDoc(id, docId, userId);
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  if (new URL(req.url).searchParams.get("download") === "1") {
    let data: Buffer;
    try {
      data = await readReferenceFile(doc.storage_key);
    } catch {
      // 行还在但原件没了。说清楚是"原件丢了"，而不是给一个空文件让人以为下载成功
      return NextResponse.json({ error: "原件已丢失" }, { status: 410 });
    }
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": doc.mime_type || "application/octet-stream",
        "Content-Length": String(data.byteLength),
        "Content-Disposition": contentDisposition(doc.name),
      },
    });
  }

  let content = "";
  // 解不开就当空：抛出去会让整个页面 500，而用户真正想看的元信息（状态、
  // 失败原因）本来是拿得到的
  if (doc.content) { try { content = decrypt(doc.content); } catch { content = ""; } }

  const chunkCount = await prisma.chunk.count({ where: { reference_doc_id: docId } });

  return NextResponse.json({
    id: doc.id,
    name: doc.name,
    mime_type: doc.mime_type,
    size_bytes: doc.size_bytes,
    status: doc.status,
    last_error: doc.last_error,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    chunk_count: chunkCount,
    content,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, docId } = await params;
  const doc = await ownedDoc(id, docId, userId);
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  await deleteReferenceDocCascade(docId);
  return NextResponse.json({ ok: true });
}
