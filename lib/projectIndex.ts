// 项目索引层。
//
// 它不是"给人看的项目文档"，而是**改写查询、生成过滤条件、决定去哪儿找**的一层
// 数据结构。三条硬约束，互相支撑：
//   1. 不呈现给用户 —— 所以字段是给检索器用的映射表，不是散文
//   2. 不被引用 —— 它是 LLM 二次加工的推论，引用它等于引用推论。引用必须落到
//      具体会议的 chunk 上
//   3. 不需要用户确认 —— 正因为不被引用，它只是一层可随时重算的缓存。缓存算错了
//      重算就行，不需要签字
// 第 2 条和第 3 条是同一个决策的两面。
//
// 参考：GraphRAG 的 community summaries（生成出来当索引用、不当答案用）、
// Graphiti 的双时间轴（事实有"从"和"到"，被顶替的不删只标记）、
// Charoite 的作者手写区（重建时整块不碰，"否则没人会去改它"）。

/** 一次重建最多喂给模型多少个来源。再多摘要开始丢细节，生成也撞上下文上限。 */
export const MAX_SOURCES = 14;
/** 单个来源在 prompt 里的字符上限。 */
export const SRC_CHARS = 2500;
/** 整个来源块的字符上限。 */
export const PROMPT_CHARS = 28_000;

/**
 * 喂给模型的一个来源。
 *
 * label 是 M1 / M2 这样的短标签，**不是 UUID**：模型抄一个 36 位的 uuid 极易
 * 出错（少一位、换一个字符），而错了的 source_id 和对的长得一模一样，事后没法
 * 分辨。短标签抄错的概率低得多，校验时也能精确判定"这个标签存在吗"。
 * 标签到 meeting_id 的映射由代码维护，模型永远看不到 uuid。
 */
export type IndexSource = {
  label: string;
  meeting_id: string;
  date: string | null;
  title: string;
  text: string;
};

export type EntityKind = "person" | "system" | "team" | "org" | "product" | "other";

export type IndexEntity = {
  canonical: string;
  aliases: string[];
  kind: EntityKind;
  note: string | null;
  source_ids: string[];
};

export type IndexGlossaryItem = {
  term: string;
  means: string;
  aliases: string[];
  source_ids: string[];
};

export type IndexTimelineItem = {
  date: string;
  event: string;
  /** 被哪个来源取代了。旧条目不删 —— "我们当初是怎么定的"要能查得到。 */
  superseded_by: string | null;
  source_ids: string[];
};

export type IndexTopic = { name: string; keywords: string[]; source_ids: string[] };

export type IndexStateItem = { claim: string; as_of: string | null; source_ids: string[] };

export type ProjectIndex = {
  entities: IndexEntity[];
  glossary: IndexGlossaryItem[];
  timeline: IndexTimelineItem[];
  topics: IndexTopic[];
  state: IndexStateItem[];
  /** 作者手写区。重建时整块原样保留，模型看不到也改不了。 */
  author_notes: string;
};

export function emptyIndex(): ProjectIndex {
  return { entities: [], glossary: [], timeline: [], topics: [], state: [], author_notes: "" };
}

const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ENTITY_KINDS = new Set<string>(["person", "system", "team", "org", "product", "other"]);

/**
 * 给会议编来源标签。
 *
 * 超过 MAX_SOURCES 时**保留最近的**，再按时间正序喂给模型：截断必然有损，丢最旧
 * 的比丢最新的好（state 讲的是"现在"）；正序排列则让 timeline 有连贯的叙事顺序。
 * Charoite 在这里踩过坑 —— 它按成员顺序取前 N 个，结果主题自己的核心节点被挤出
 * prompt，摘要在缺主源的情况下生成，而且最大的主题受害最深，还是静默的。
 */
export function buildSources(
  meetings: Array<{ id: string; date: string | null; title: string; text: string }>,
): IndexSource[] {
  const sorted = [...meetings].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const kept = sorted.slice(Math.max(0, sorted.length - MAX_SOURCES));
  return kept.map((m, i) => ({
    label: `M${i + 1}`,
    meeting_id: m.id,
    date: m.date,
    title: m.title,
    text: m.text,
  }));
}

/** 来源块文本。超过 PROMPT_CHARS 就停在上一条，不吐半截来源。 */
export function renderSources(sources: IndexSource[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const s of sources) {
    const head = `### ${s.label} | ${s.date ?? "日期不详"} | ${s.title}`;
    const block = `${head}\n${s.text.slice(0, SRC_CHARS)}\n`;
    if (total + block.length > PROMPT_CHARS) break;
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n");
}

/** 结构校验。返回 null = 通过。 */
export function validateProjectIndex(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "索引必须是对象";
  const o = value as Record<string, unknown>;

  for (const field of ["entities", "glossary", "timeline", "topics", "state"]) {
    if (!Array.isArray(o[field])) return `字段 ${field} 必须是数组`;
  }
  if (o.author_notes !== undefined && typeof o.author_notes !== "string") {
    return "author_notes 必须是字符串";
  }

  const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

  for (const [i, raw] of (o.entities as unknown[]).entries()) {
    const e = raw as Record<string, unknown>;
    if (!e || typeof e.canonical !== "string" || !e.canonical.trim()) return `entities[${i}].canonical 必须是非空字符串`;
    if (!strArr(e.aliases)) return `entities[${i}].aliases 必须是字符串数组`;
    if (typeof e.kind !== "string" || !ENTITY_KINDS.has(e.kind)) return `entities[${i}].kind 取值非法：${String(e.kind)}`;
    if (e.note !== null && typeof e.note !== "string") return `entities[${i}].note 必须是字符串或 null`;
    if (!strArr(e.source_ids)) return `entities[${i}].source_ids 必须是字符串数组`;
  }
  for (const [i, raw] of (o.glossary as unknown[]).entries()) {
    const g = raw as Record<string, unknown>;
    if (!g || typeof g.term !== "string" || !g.term.trim()) return `glossary[${i}].term 必须是非空字符串`;
    if (typeof g.means !== "string") return `glossary[${i}].means 必须是字符串`;
    if (!strArr(g.aliases)) return `glossary[${i}].aliases 必须是字符串数组`;
    if (!strArr(g.source_ids)) return `glossary[${i}].source_ids 必须是字符串数组`;
  }
  for (const [i, raw] of (o.timeline as unknown[]).entries()) {
    const t = raw as Record<string, unknown>;
    if (!t || typeof t.date !== "string" || !DATE_RE.test(t.date)) return `timeline[${i}].date 必须是 YYYY-MM-DD，收到：${String(t?.date)}`;
    if (typeof t.event !== "string" || !t.event.trim()) return `timeline[${i}].event 必须是非空字符串`;
    if (t.superseded_by !== null && typeof t.superseded_by !== "string") return `timeline[${i}].superseded_by 必须是字符串或 null`;
    if (!strArr(t.source_ids)) return `timeline[${i}].source_ids 必须是字符串数组`;
  }
  for (const [i, raw] of (o.topics as unknown[]).entries()) {
    const t = raw as Record<string, unknown>;
    if (!t || typeof t.name !== "string" || !t.name.trim()) return `topics[${i}].name 必须是非空字符串`;
    if (!strArr(t.keywords)) return `topics[${i}].keywords 必须是字符串数组`;
    if (!strArr(t.source_ids)) return `topics[${i}].source_ids 必须是字符串数组`;
  }
  for (const [i, raw] of (o.state as unknown[]).entries()) {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s.claim !== "string" || !s.claim.trim()) return `state[${i}].claim 必须是非空字符串`;
    if (s.as_of !== null && (typeof s.as_of !== "string" || !DATE_RE.test(s.as_of))) return `state[${i}].as_of 必须是 YYYY-MM-DD 或 null，收到：${String(s.as_of)}`;
    if (!strArr(s.source_ids)) return `state[${i}].source_ids 必须是字符串数组`;
  }
  return null;
}

export type GroundReport = {
  /** source_ids 里出现过的、不存在的标签数 */
  unknown_labels: number;
  /** 因为一个有效来源都不剩而被整条丢弃的条目数 */
  dropped_entries: number;
  /** 规范名和别名在全部来源文本里都没出现过，因而被丢弃的实体数 */
  ungrounded_entities: number;
};

/**
 * 把模型输出落到实处：标签换成 meeting_id，并丢掉站不住的条目。
 *
 * 两条丢弃规则，都是"宁可没有，不要错的"：
 * - **一个有效来源都不剩的条目整条丢掉**。索引层自己不被引用，但它指向的东西
 *   必须可引用；指不到任何地方的条目在检索里毫无用处，留着只会污染。
 * - **规范名和别名在所有来源文本里都找不到的实体丢掉**。模型很乐意"合理地"造出
 *   一个没人说过的系统名或人名，而造出来的实体和真的长得一样。Graphiti 的去重
 *   提示词第一句就是"绝不要编造实体名" —— 但那是祈使句，这里是校验。
 */
export function groundIndex(
  index: ProjectIndex,
  sources: IndexSource[],
): { index: ProjectIndex; report: GroundReport } {
  const byLabel = new Map(sources.map((s) => [s.label, s.meeting_id]));
  const corpus = sources.map((s) => s.text).join("\n").toLowerCase();
  const report: GroundReport = { unknown_labels: 0, dropped_entries: 0, ungrounded_entities: 0 };

  const resolve = (ids: string[]): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const meetingId = byLabel.get(id);
      if (!meetingId) {
        report.unknown_labels++;
        continue;
      }
      if (!out.includes(meetingId)) out.push(meetingId);
    }
    return out;
  };

  function keep<T extends { source_ids: string[] }>(items: T[]): T[] {
    const out: T[] = [];
    for (const item of items) {
      const source_ids = resolve(item.source_ids);
      if (source_ids.length === 0) {
        report.dropped_entries++;
        continue;
      }
      out.push({ ...item, source_ids });
    }
    return out;
  }

  const entities = keep(index.entities).filter((e) => {
    // 规范名或任一别名在语料里出现过，就算落到了实处
    const names = [e.canonical, ...e.aliases].map((n) => n.trim().toLowerCase()).filter(Boolean);
    const grounded = names.some((n) => corpus.includes(n));
    if (!grounded) report.ungrounded_entities++;
    return grounded;
  });

  const timeline = keep(index.timeline).map((t) => ({
    ...t,
    // 顶替关系指向的必须是真实存在的来源，否则当没有
    superseded_by: t.superseded_by && byLabel.has(t.superseded_by) ? byLabel.get(t.superseded_by)! : null,
  }));

  return {
    index: {
      entities,
      glossary: keep(index.glossary),
      timeline,
      topics: keep(index.topics),
      state: keep(index.state),
      author_notes: index.author_notes ?? "",
    },
    report,
  };
}

/**
 * 重建时保留作者手写区。
 *
 * 不做字段级 provenance，而是物理隔离一整块：实现简单一个量级，不会出现"某个
 * 字段的标记漏更新"这类 bug，也和"索引层整体替换"的幂等性天然相容。
 * Charoite 的 preserve_manual 一句注释说透了理由 —— 手动修改必须活过重建，
 * 否则没人会去改它。
 */
export function preserveAuthorNotes(rebuilt: ProjectIndex, previous: ProjectIndex | null): ProjectIndex {
  return { ...rebuilt, author_notes: (previous?.author_notes ?? "").trim() };
}

/** 索引摘要的字符预算。查询分析每问一次就跑一次，不能把它撑大。 */
export const DIGEST_CHARS = 1800;

/**
 * 把索引层压成一段紧凑文本，供查询分析使用。
 *
 * 这是索引层**唯一的对外出口**：它只进查询分析，不进生成上下文。所以它影响的是
 * "去哪儿找"，而答案的引用始终落在具体会议的 chunk 上——索引层自己永远不会被
 * 引用。这正是"不被溯源 ⇔ 不需要确认"那条设计约束的落点。
 *
 * 超预算时**整行整行地丢**，不切半行：半行"人物与系统：王磊(小王"会让模型读到
 * 残缺的对照关系，比没有更糟。按 entities → glossary → timeline → topics 的
 * 顺序保留，因为解析口语指代的收益最大。
 */
export function renderIndexDigest(index: ProjectIndex): string {
  const byUsage = <T extends { source_ids: string[] }>(a: T, b: T) => b.source_ids.length - a.source_ids.length;
  const candidates: string[] = [];

  // note 必须带上。实测教训：只给"名字(别名)"时，问"那个负责安全的人"模型没有任何
  // 依据判断是谁，于是猜了一个——并且带着一个自信的 speakers 过滤器进检索，把正确
  // 答案结构性地滤掉了。没有职责信息时它至少会留空，那反而是对的。
  const people = [...index.entities].sort(byUsage).map((e) => {
    const alias = e.aliases.length ? `(${e.aliases.join("、")})` : "";
    const note = e.note ? `：${e.note.slice(0, 40)}` : "";
    return `${e.canonical}${alias}${note}`;
  });
  if (people.length) candidates.push("人物与系统：" + people.join("；"));

  const terms = [...index.glossary].sort(byUsage)
    .map((g) => (g.aliases.length ? `${g.term}(${g.aliases.join("、")})` : g.term));
  if (terms.length) candidates.push("项目术语：" + terms.join(" · "));

  const timeline = [...index.timeline].sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => `${t.date} ${t.event.slice(0, 30)}${t.superseded_by ? "[已被后续会议取代]" : ""}`);
  if (timeline.length) candidates.push("时间轴：" + timeline.join(" | "));

  const topics = index.topics.map((t) => t.name);
  if (topics.length) candidates.push("主题：" + topics.join(" · "));

  const lines: string[] = [];
  let total = 0;
  for (const line of candidates) {
    if (total + line.length > DIGEST_CHARS) continue;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}
