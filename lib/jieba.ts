import { cut, add_word } from "jieba-wasm/node";

// 补充默认词典未收录的专有名词和技术词汇
const CUSTOM_WORDS = [
  "魁北克", "UDP", "TCP", "AWS", "EC2",
  "pgvector", "Neon", "Vercel", "Clerk",
];
for (const word of CUSTOM_WORDS) {
  add_word(word);
}

// 查询中常见的功能词，分词后过滤掉
const QUERY_STOP_WORDS = new Set([
  "什么", "怎么", "如何", "哪些", "哪里", "是否", "有没有", "有人",
  "请问", "告诉", "介绍", "描述", "相关", "什么时候", "为什么", "为何",
  "可以", "能否", "时候", "情况", "结果", "内容", "方面", "问题",
  "进行", "完成", "实现", "使用", "采用", "通过", "关于", "针对",
]);

export function extractKeywords(text: string): string[] {
  const segments = cut(text, true);

  const chineseKeywords = segments.filter(
    (s) => s.length >= 2 && !QUERY_STOP_WORDS.has(s) && /[一-鿿]/.test(s),
  );

  const latinKeywords = Array.from(
    text.matchAll(/[A-Za-z][A-Za-z0-9_\-]*/g),
    (m) => m[0],
  ).filter((s) => s.length >= 2);

  return [...new Set([...chineseKeywords, ...latinKeywords])].slice(0, 8);
}
