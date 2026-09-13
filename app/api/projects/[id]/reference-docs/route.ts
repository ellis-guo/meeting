import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { buildStorageKey, saveReferenceFile, deleteReferenceFile } from "@/lib/fileStorage";
import { detectKind, fileExtension, MAX_FILE_BYTES } from "@/lib/documentParser";
import { enqueue } from "@/lib/jobs";
import { startBackgroundDrain } from "@/lib/jobRunner";
import { registerJobHandlers } from "@/lib/registerJobs";

// 参考文件的上传与列表。
//
// 上传只做三件事：收下文件、落库、排解析任务，然后立刻返回。解析（抽文本、
// 切块、几十次 embedding）是分钟级的，挂在 HTTP 请求上必然超时。

/** 一次请求最多几份文件。 */
const MAX_FILES_PER_REQUEST = 10;
/**
 * 一次请求的总字节上限。
 *
 * 必须留在 next.config.ts 的 `proxyClientMaxBodySize`（24mb）以下：超过那个值
 * 时 Next **不会报错**，只把前 24MB 交给这个路由，剩下的静默丢掉——表现成
 * "最后一个文件解析失败"，跟真实原因毫无关系。
 */
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

async function ownedProject(projectId: string, userId: string) {
  return prisma.project.findFirst({ where: { id: projectId, user_id: userId }, select: { id: true } });
}

/** 列出项目的参考文件。不返回 content——列表页只需要元信息，正文可能很大。 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!(await ownedProject(id, userId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const docs = await prisma.referenceDoc.findMany({
    where: { project_id: id },
    orderBy: { created_at: "desc" },
    select: {
      id: true, name: true, mime_type: true, size_bytes: true,
      status: true, last_error: true, created_at: true, updated_at: true,
    },
  });

  // chunk 数单独查：它是"这份文件到底进没进检索池"最直接的证据，比 status 更硬
  const counts = await prisma.chunk.groupBy({
    by: ["reference_doc_id"],
    where: { reference_doc_id: { in: docs.map((d) => d.id) } },
    _count: { _all: true },
  });
  const byDoc = new Map(counts.map((c) => [c.reference_doc_id, c._count._all]));

  return NextResponse.json({
    docs: docs.map((d) => ({ ...d, chunk_count: byDoc.get(d.id) ?? 0 })),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = checkRateLimit(userId, "POST:/api/projects/reference-docs");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const { id: projectId } = await params;
  if (!(await ownedProject(projectId, userId))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // 先看 Content-Length 再读 body。读完再判断是没用的：body 早就被截断了，
  // 这里拿到的"实际大小"正好等于上限，看起来完全正常。
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) {
    return NextResponse.json(
      { error: `一次最多上传 ${Math.floor(MAX_REQUEST_BYTES / 1024 / 1024)}MB，请分批传` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "请求不是合法的 multipart/form-data" }, { status: 400 });
  }

  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "没有收到文件" }, { status: 400 });
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json({ error: `一次最多 ${MAX_FILES_PER_REQUEST} 份文件` }, { status: 400 });
  }

  // 先全部校验再落任何一份：避免"前三份成功、第四份格式不对"这种半成功状态，
  // 用户没法判断到底哪些进去了。
  for (const f of files) {
    if (f.size === 0) {
      return NextResponse.json({ error: `「${f.name}」是空文件` }, { status: 400 });
    }
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `「${f.name}」超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB 单文件上限` },
        { status: 413 },
      );
    }
    if (!detectKind(f.name, f.type)) {
      const ext = fileExtension(f.name);
      return NextResponse.json(
        {
          error: ext === "doc"
            ? `「${f.name}」是旧版 .doc，请用 Word 另存为 .docx 后再上传`
            : `「${f.name}」格式不支持，目前支持 PDF / Word(.docx) / 纯文本`,
        },
        { status: 415 },
      );
    }
  }

  registerJobHandlers();

  const created: Array<{ id: string; name: string; status: string }> = [];
  const writtenKeys: string[] = [];
  try {
    for (const f of files) {
      const key = buildStorageKey(projectId, f.name);
      await saveReferenceFile(key, new Uint8Array(await f.arrayBuffer()));
      writtenKeys.push(key);

      const doc = await prisma.referenceDoc.create({
        data: {
          user_id: userId,
          project_id: projectId,
          // 原始文件名只用来显示和下载。磁盘上的路径是 uuid，见 fileStorage。
          name: f.name.slice(0, 255),
          mime_type: f.type.slice(0, 255),
          size_bytes: f.size,
          storage_key: key,
          status: "uploaded",
        },
        select: { id: true, name: true, status: true },
      });
      created.push(doc);

      await enqueue({ userId, projectId, type: "parse_document", payload: { referenceDocId: doc.id } });
    }
  } catch (e) {
    // 半路失败：把这次已经写进磁盘的文件清掉，别留孤儿。数据库行由调用方重试
    // 时重建——已经 create 成功的行会留下，但它们的任务也排好了，不影响。
    await Promise.all(writtenKeys.map((k) => deleteReferenceFile(k).catch(() => {})));
    throw e;
  }

  // 立刻在后台开始解析，不等下一次 tick。tick 是每小时一次的兜底，上传后
  // 干等一小时才开始解析对用户来说就是"坏了"。
  startBackgroundDrain();

  return NextResponse.json({ ok: true, docs: created }, { status: 201 });
}
