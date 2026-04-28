// Schema validators for ProjectMemory (project.document) and DocumentDiff.
//
// 用途：
// 1. 后台异步生成 diff 时校验 LLM 输出（防止 next_meeting_goals 之类的字段写错类型）
// 2. apply API 入口防御校验（防止脏数据落库）

const ARRAY_FIELDS = new Set([
  "goals",
  "members",
  "milestones",
  "key_decisions",
  "open_issues",
  "risks",
  "glossary",
  "checklist",
]);

const STRING_FIELDS = new Set(["overview"]);

const KNOWN_FIELDS = new Set<string>([...ARRAY_FIELDS, ...STRING_FIELDS]);

/** 校验 project.document 整体结构。返回 null = 通过；否则返回错误信息。 */
export function validateProjectDoc(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null) return "document 必须是对象";
  const o = doc as Record<string, unknown>;
  for (const f of ARRAY_FIELDS) {
    const v = o[f];
    if (v !== undefined && v !== null && !Array.isArray(v)) {
      return `字段 "${f}" 必须是数组或 null（实际类型: ${typeof v}）`;
    }
  }
  for (const f of STRING_FIELDS) {
    const v = o[f];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return `字段 "${f}" 必须是字符串或 null（实际类型: ${typeof v}）`;
    }
  }
  return null;
}

/** 校验 LLM 输出的 diff 结构，且每个 update 的 new 类型与 field 期望一致。 */
export function validateDiff(diff: unknown): string | null {
  if (typeof diff !== "object" || diff === null) return "diff 必须是对象";
  const d = diff as Record<string, unknown>;
  if (!Array.isArray(d.updates)) return "diff.updates 必须是数组";
  for (let i = 0; i < d.updates.length; i++) {
    const u = d.updates[i] as Record<string, unknown> | null;
    if (!u || typeof u !== "object") return `updates[${i}] 必须是对象`;
    if (typeof u.field !== "string") return `updates[${i}].field 必须是字符串`;
    if (!KNOWN_FIELDS.has(u.field)) {
      return `updates[${i}].field "${u.field}" 不在已知字段列表内`;
    }
    if (ARRAY_FIELDS.has(u.field)) {
      if (u.new !== null && !Array.isArray(u.new)) {
        return `updates[${i}] (field=${u.field}) 的 new 必须是数组或 null（实际类型: ${typeof u.new}）`;
      }
    }
    if (STRING_FIELDS.has(u.field)) {
      if (u.new !== null && typeof u.new !== "string") {
        return `updates[${i}] (field=${u.field}) 的 new 必须是字符串或 null（实际类型: ${typeof u.new}）`;
      }
    }
  }
  return null;
}
