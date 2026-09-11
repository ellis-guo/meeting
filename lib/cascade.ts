import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { markIndexDirty } from "@/lib/dreaming";

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

/** 删除整个项目：先清所有会议，再清项目级通知和项目本身。 */
export async function deleteProjectCascade(projectId: string, userId: string): Promise<void> {
  const meetings = await prisma.meeting.findMany({
    where: { project_id: projectId },
    select: { id: true },
  });
  const meetingIds = meetings.map((m) => m.id);

  await prisma.$transaction([
    ...meetingCascadeOps(meetingIds, userId),
    prisma.notification.deleteMany({
      where: { user_id: userId, link: { contains: `/projects/${projectId}` } },
    }),
    prisma.project.delete({ where: { id: projectId } }),
  ]);
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
