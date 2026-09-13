import { prisma } from "@/lib/prisma";
import { encrypt, encryptJSON } from "@/lib/crypto";
import { readReferenceFile } from "@/lib/fileStorage";
import { extractDocumentText, UnparseableDocument } from "@/lib/documentParser";
import { buildReferenceChunks, insertChunks, embedAndStore } from "@/lib/chunking";
import type { ClaimedJob } from "@/lib/jobs";

// parse_document 的处理函数：把上传的原件解析成文本，切块、embed，落进检索池。
//
// 走队列而不是在上传请求里同步做：一份 100 页的 PDF 抽文本 + 几十次 embedding
// 调用是分钟级的，挂在 HTTP 请求上会超时，而且浏览器一刷新用户就以为失败了。
// 上传接口只负责"收下文件 + 排队"，立刻返回。

/** 处理函数的 payload 形状。 */
export type ParseDocumentPayload = { referenceDocId: string };

function isPayload(v: unknown): v is ParseDocumentPayload {
  return typeof v === "object" && v !== null
    && typeof (v as ParseDocumentPayload).referenceDocId === "string";
}

async function log(docId: string, level: string, context: Record<string, unknown>): Promise<void> {
  await prisma.processingLog
    .create({
      // meeting_id 留空：参考文件不属于任何一场会议
      data: { level, meeting_id: null, context: encryptJSON({ reference_doc_id: docId, ...context }) },
    })
    .catch(() => {});
}

/**
 * 把"这个文件解不了"记到文档行上，而**不是**让任务失败。
 *
 * 区分的判据是老一套：重试能不能改变结果。扫描版 PDF、加密文件、老版 .doc
 * 再跑三遍还是同样的结果，塞回队列只会烧掉重试次数、让 Job 表里堆一批
 * failed，而真正需要人看的信息（哪份文件、为什么不行）反倒藏在 last_error 的
 * 堆栈里。记在 ReferenceDoc.status 上，前端能直接把原因显示给用户。
 */
async function markUnparseable(docId: string, reason: string): Promise<void> {
  await prisma.referenceDoc.updateMany({
    where: { id: docId },
    data: { status: "failed", last_error: reason },
  });
  await log(docId, "warn", { type: "reference_parse_unparseable", reason });
}

export async function runParseDocument(job: ClaimedJob): Promise<{ tokensUsed?: number } | void> {
  if (!isPayload(job.payload)) throw new Error("parse_document 的 payload 缺少 referenceDocId");
  const docId = job.payload.referenceDocId;

  const doc = await prisma.referenceDoc.findUnique({
    where: { id: docId },
    select: { id: true, project_id: true, name: true, mime_type: true, storage_key: true },
  });
  // 文件在排队期间被删了。这不是失败——该做的事已经不存在了。
  if (!doc) return;

  await prisma.referenceDoc.updateMany({
    where: { id: docId },
    data: { status: "parsing", last_error: null },
  });

  let data: Buffer;
  try {
    data = await readReferenceFile(doc.storage_key);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // 原件不在磁盘上了。重试不会让它回来。
      await markUnparseable(docId, "原件已丢失，请重新上传");
      return;
    }
    throw e; // 磁盘 I/O 故障是暂时的，交给队列重试
  }

  let text: string;
  let kind: string;
  let truncated: boolean;
  try {
    ({ kind, text, truncated } = await extractDocumentText(data, doc.name, doc.mime_type));
  } catch (e) {
    if (e instanceof UnparseableDocument) {
      await markUnparseable(docId, e.message);
      return;
    }
    throw e;
  }

  const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
  // 不能用 getDashScopeKey()：它读 cookie + Clerk auth，都是请求作用域的，
  // 后台任务里没有用户会话。
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY 未配置，无法给参考文件建索引");

  // 先删旧 chunk 再建新的：这个任务可能是重试，也可能是同一份文件被重新解析
  // （解析器升级后重抽）。不删的话检索池里会同时存在两份，命中率被自己稀释。
  await prisma.chunk.deleteMany({ where: { reference_doc_id: docId } });

  const inputs = buildReferenceChunks(text, docId, doc.project_id, doc.name);
  const created = await insertChunks(inputs);
  const { tokens } = await embedAndStore(created, null, apiKey);

  await prisma.referenceDoc.update({
    where: { id: docId },
    data: { content: encrypt(text), status: "ready", last_error: null },
  });

  await log(docId, truncated ? "warn" : "info", {
    type: "reference_parsed",
    kind,
    chars: text.length,
    chunks: created.length,
    truncated,
    embed_tokens: tokens,
  });

  // 索引层暂时不标脏：dreamHandler 现在只读会议摘要，参考文件进不了它的来源集，
  // 标脏只会让夜里白跑一次 plus 重建出一份一模一样的索引。等索引层的来源扩展到
  // 参考文件（要改 IndexSource / groundIndex / prompt）时再接上。
  return { tokensUsed: tokens };
}
