import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { markIndexDirty } from "@/lib/dreaming";
import { deleteReferenceFile } from "@/lib/fileStorage";

// 级联删除。schema 里没有配 onDelete: Cascade，且 ChunkParent 根本没有外键关系，
// 所以每个删除入口都必须手动按 chunks → parents → notifications → 主表 的顺序清。
// 集中在这里，避免再出现"某个入口漏删 ChunkParent"这类孤儿数据。

/** 删除一批会议及其全部衍生数据的操作序列（调用方塞进 $transaction）。 */
export function meetingCascadeOps(
  meetingIds: string[],
  userId: string,
): Prisma.PrismaPromise<unknown>[] {
  if (meetingIds.length === 0) return [];
  return [
    prisma.chunk.deleteMany({ where: { meeting_id: { in: meetingIds } } }),
    prisma.chunkParent.deleteMany({ where: { meeting_id: { in: meetingIds } } }),
    prisma.processingLog.deleteMany({ where: { meeting_id: { in: meetingIds } } }),
    // 通知的 link 形如 /projects/{pid}/meetings/{mid}?diff=1，会议删掉后点进去是 404
    ...meetingIds.map((id) =>
      prisma.notification.deleteMany({
        where: { user_id: userId, link: { contains: `/meetings/${id}` } },
      }),
    ),
    prisma.meeting.deleteMany({ where: { id: { in: meetingIds } } }),
  ];
}

/** 删除一批参考文件及其 chunks 的操作序列（调用方塞进 $transaction）。 */
export function referenceDocCascadeOps(docIds: string[]): Prisma.PrismaPromise<unknown>[] {
  if (docIds.length === 0) return [];
  return [
    // 必须排在 referenceDoc 删除之前：Chunk_reference_doc_id_fkey 是 RESTRICT，
    // 顺序反了会直接报错——这是有意的，好过静默留下没有出处的 chunk。
    prisma.chunk.deleteMany({ where: { reference_doc_id: { in: docIds } } }),
    prisma.referenceDoc.deleteMany({ where: { id: { in: docIds } } }),
  ];
}

/**
 * 删除磁盘上的原件。**必须在数据库事务提交之后调用**。
 *
 * 顺序不能反：文件先删、事务后回滚的话，行还在而原件没了——那是个无法自愈的
 * 状态，用户看得见文件却下载不了、也重新解析不了。反过来（事务成功、删文件
 * 失败）只是留下一个孤儿文件，占点磁盘，随时可以扫掉。
 *
 * 所以这里吞掉异常：文件删不掉不该让一个已经成功的删除操作报错。
 */
async function purgeFiles(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => deleteReferenceFile(k).catch(() => {})));
}

/** 删除单个参考文件及其 chunks，连同磁盘上的原件。 */
export async function deleteReferenceDocCascade(docId: string): Promise<void> {
  const doc = await prisma.referenceDoc.findUnique({
    where: { id: docId },
    select: { storage_key: true },
  });
  await prisma.$transaction(referenceDocCascadeOps([docId]));
  await purgeFiles(doc?.storage_key ? [doc.storage_key] : []);
}

/** 删除整个项目：先清所有会议和参考文件，再清项目级通知和项目本身。 */
export async function deleteProjectCascade(projectId: string, userId: string): Promise<void> {
  const [meetings, docs] = await Promise.all([
    prisma.meeting.findMany({ where: { project_id: projectId }, select: { id: true } }),
    prisma.referenceDoc.findMany({
      where: { project_id: projectId },
      select: { id: true, storage_key: true },
    }),
  ]);
  const meetingIds = meetings.map((m) => m.id);
  const docIds = docs.map((d) => d.id);

  await prisma.$transaction([
    ...meetingCascadeOps(meetingIds, userId),
    // ReferenceDoc_project_id_fkey 同样是 RESTRICT：漏了这一步，项目一旦有参考
    // 文件就再也删不掉了。
    ...referenceDocCascadeOps(docIds),
    prisma.notification.deleteMany({
      where: { user_id: userId, link: { contains: `/projects/${projectId}` } },
    }),
    prisma.project.delete({ where: { id: projectId } }),
  ]);

  await purgeFiles(docs.map((d) => d.storage_key).filter(Boolean));
}

/** 删除单个会议及其衍生数据。 */
export async function deleteMeetingCascade(meetingId: string, userId: string): Promise<void> {
  // 先取 project_id：删完就查不到了
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { project_id: true },
  });
  await prisma.$transaction(meetingCascadeOps([meetingId], userId));
  // 少了一场会议同样让索引层过期——索引里还留着这次会议的实体和时间轴条目
  await markIndexDirty(meeting?.project_id);
}
