import { prisma } from "@/lib/prisma";
import { encryptJSON, decryptJSON } from "@/lib/crypto";
import { callDashScope, CHAT_MODEL } from "@/lib/dashscope";
import { PROJECT_INDEX_PROMPT } from "@/lib/prompts";
import { extractJSON } from "@/lib/utils";
import type { ClaimedJob } from "@/lib/jobs";
import type { Section, Summary } from "@/lib/chunking";
import {
  buildSources,
  emptyIndex,
  groundIndex,
  preserveAuthorNotes,
  renderSources,
  validateProjectIndex,
  type ProjectIndex,
} from "@/lib/projectIndex";

// dreaming 的处理函数：把一个项目的全部会议摘要重新炼成索引层。
//
// 整体替换而不是增量修改 —— 这让它天然幂等：跑一半崩了，下次从头再来即可，
// 不需要断点续传，也不会出现"改了一半的索引"。

/**
 * 索引层用 plus，**不跟随"后台任务一律降 flash"的通则**。
 *
 * 实测（7 场会议的真实项目、同一份来源）：flash 21s 产 17 个实体，其中 1 个是
 * 语料里根本没有的人名（被 groundIndex 拦下了）；plus 48s 产 10 个实体，0 编造。
 * 但真正的理由不是编造——落地校验本来就能拦住编造，**它拦不住"松"**：flash 多
 * 出来的术语是 "Phase 1" 这类阶段名而非项目术语。而索引层是路由层，它松一点，
 * 后面每一次检索都跟着差。
 *
 * 成本不构成反对理由：每个脏项目每晚一次，实测约 7600 tokens。
 */
export const DREAM_MODEL = CHAT_MODEL;

function renderSection(section: Section): string {
  const c = section.content;
  if (c.type === "text") return `${section.title}: ${c.value}`;
  if (c.type === "bullets") {
    const items = c.items.map((item) => {
      const subs = item.sub_items?.map((s) => `    - ${s.text}`).join("\n") ?? "";
      return subs ? `  - ${item.text}\n${subs}` : `  - ${item.text}`;
    });
    return `${section.title}:\n${items.join("\n")}`;
  }
  const rows = c.rows.map((r) => `  ${r.cells.join(" | ")}`).join("\n");
  return `${section.title}:\n  ${c.columns.join(" | ")}\n${rows}`;
}

function decodeIndex(stored: string): ProjectIndex | null {
  if (!stored) return null;
  try {
    return decryptJSON<ProjectIndex>(stored);
  } catch {
    // 解不开就当没有旧索引。代价是这一轮丢掉作者手写区——但抛出去会让整个项目
    // 永远重建不了，那更糟。记一条日志，让它可见。
    return null;
  }
}

async function log(projectId: string, level: string, context: Record<string, unknown>): Promise<void> {
  await prisma.processingLog
    .create({ data: { level, meeting_id: null, context: encryptJSON({ project_id: projectId, ...context }) } })
    .catch(() => {});
}

/**
 * 写回索引层。
 *
 * 索引本体和 index_built_at 无条件写；**index_dirty 只在"重建期间没人动过这个
 * 项目"时才清**。守卫用的是开工时读到的 index_dirty_at：如果期间有新会议或编辑
 * 进来，这个时间戳会变，脏标记就留着等下一轮。没有这道守卫，落在重建窗口里的
 * 那次改动会被永久漏掉，而且完全没有迹象。
 */
async function persist(
  projectId: string,
  index: ProjectIndex,
  dirtyAtAtStart: Date | null,
): Promise<boolean> {
  await prisma.project.update({
    where: { id: projectId },
    data: { index_json: encryptJSON(index), index_built_at: new Date() },
  });
  const { count } = await prisma.project.updateMany({
    where: { id: projectId, index_dirty_at: dirtyAtAtStart },
    data: { index_dirty: false },
  });
  return count > 0;
}

export async function runDreaming(job: ClaimedJob): Promise<{ tokensUsed?: number }> {
  const projectId = job.project_id;
  if (!projectId) throw new Error("dreaming 任务缺少 project_id");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, index_json: true, index_dirty_at: true },
  });
  // 项目已被删除：安静结束，不算失败——重试多少次它也不会回来
  if (!project) return {};

  const dirtyAtAtStart = project.index_dirty_at;
  const previous = decodeIndex(project.index_json);
  if (project.index_json && !previous) {
    await log(projectId, "warn", { type: "index_decode_failed" });
  }

  const meetings = await prisma.meeting.findMany({
    where: { project_id: projectId },
    select: { id: true, summary: true, created_at: true },
    orderBy: { created_at: "asc" },
  });

  let unreadable = 0;
  const parsed = meetings.flatMap((m) => {
    let summary: Summary;
    // 单场会议解不开就跳过它，而不是让整个项目的索引重建失败
    try {
      summary = decryptJSON<Summary>(m.summary);
    } catch {
      unreadable++;
      return [];
    }
    const sections = Array.isArray(summary.sections) ? summary.sections : [];
    if (sections.length === 0) return [];
    return [{
      id: m.id,
      date: summary.meta?.date ?? null,
      title: sections[0]?.title ?? "会议",
      text: sections.map(renderSection).join("\n"),
    }];
  });

  if (parsed.length === 0) {
    // 没有可用语料。照样写空索引并清脏，否则这个项目每晚都会被排一次任务。
    const cleared = await persist(projectId, preserveAuthorNotes(emptyIndex(), previous), dirtyAtAtStart);
    await log(projectId, "warn", { type: "index_no_sources", meetings: meetings.length, unreadable, cleared });
    return {};
  }

  const apiKey = process.env.DASHSCOPE_API_KEY ?? "";
  // 不能用 getDashScopeKey()：它读 cookie + Clerk auth，都是请求作用域的，
  // 后台任务里没有用户会话。所以 dreaming 一律走服务端 key。
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY 未配置，dreaming 无法运行");

  const sources = buildSources(parsed);
  const { content, usage } = await callDashScope(
    PROJECT_INDEX_PROMPT,
    `以下是本项目的会议来源：\n\n${renderSources(sources)}`,
    apiKey,
    DREAM_MODEL,
  );

  // 下面两处失败都直接抛：交给队列按退避策略重试，三次都不成才进 failed。
  // 在这里吞掉的话，坏索引会静默覆盖好索引。
  const raw = extractJSON(content);
  const schemaError = validateProjectIndex(raw);
  if (schemaError) throw new Error(`索引结构校验不通过：${schemaError}`);

  const { index: grounded, report } = groundIndex(raw as ProjectIndex, sources);
  const cleared = await persist(projectId, preserveAuthorNotes(grounded, previous), dirtyAtAtStart);

  await log(projectId, report.ungrounded_entities > 0 || report.dropped_entries > 0 ? "warn" : "info", {
    type: "index_rebuilt",
    model: DREAM_MODEL,
    sources: sources.length,
    meetings: meetings.length,
    unreadable,
    entities: grounded.entities.length,
    glossary: grounded.glossary.length,
    timeline: grounded.timeline.length,
    topics: grounded.topics.length,
    state: grounded.state.length,
    ...report,
    // false = 重建期间这个项目又被改了，脏标记留着等下一轮
    dirty_cleared: cleared,
    tokens: usage?.total_tokens ?? null,
  });

  return { tokensUsed: usage?.total_tokens };
}
