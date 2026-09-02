import type { NextRequest } from "next/server";

// 语言偏好写在 lang_pref cookie 里（见 /api/auth/preferences）。
// 所有调用 LLM 生成用户可见文本的路由都必须把 langRule 拼进 user message，
// 否则模型会退回“按转写稿主导语言输出”，导致设置页的偏好静默失效。

export type Lang = "zh" | "en";

const RULES: Record<Lang, string> = {
  zh: "输出语言：以中文为主，学术名词、专有名词、代码标识符保留英文原文。",
  en: "Output language: English. Retain original form for technical terms and proper nouns.",
};

export function getLang(req: NextRequest): Lang {
  return req.cookies.get("lang_pref")?.value === "en" ? "en" : "zh";
}

export function getLangRule(req: NextRequest): string {
  return RULES[getLang(req)];
}
