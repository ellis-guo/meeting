import { Fragment } from "react";

/**
 * 把 `[左 · 右]` 这样的引用解析成链接，返回 null 表示无法定位（渲染成灰色不可点）。
 *
 * 左边原本只可能是日期（`[2026-04-18 · 章节标题]`），加了参考文件之后还可能是
 * "参考文件"（`[参考文件 · 文件名 › 章节]`）。这里不认识任何一种具体形态，
 * 两段原样交给调用方——谁提供 resolve，谁知道自己的来源长什么样。
 */
export type CitationResolver = (head: string, section: string) => string | null;

function renderInline(text: string, resolve?: CitationResolver): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+·[^\]]+\])/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    const m = part.match(/^\[([^\]·]+)·([^\]]+)\]$/);
    if (m) {
      const href = resolve?.(m[1].trim(), m[2].trim()) ?? null;
      return href
        ? <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-lark-border text-lark-3 hover:text-lark-blue transition-colors text-xs">{part}</a>
        : <span key={i} className="text-lark-4 text-xs">{part}</span>;
    }
    return part;
  });
}

/** 模型回答的极简 markdown 渲染：## / ### 标题、* 列表、** 加粗、引用链接。 */
export default function AskMarkdown({ text, resolve }: { text: string; resolve?: CitationResolver }) {
  const rawLines = text.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    // 模型偶尔把 "•" 和内容拆成两行，合回一行再渲染
    if (/^[•*]\s*$/.test(rawLines[i]) && i + 1 < rawLines.length && rawLines[i + 1].trim() !== "") {
      lines.push(`* ${rawLines[i + 1].trim()}`);
      i++;
    } else {
      lines.push(rawLines[i]);
    }
  }

  return (
    <>
      {lines.map((line, i) => {
        const h2 = line.match(/^##\s+(.+)/);
        const h3 = line.match(/^###\s+(.+)/);
        const bullet = line.match(/^[*•]\s+(.+)/);
        if (h2) return <p key={i} className="text-base font-semibold text-lark-1 mt-4 mb-0.5">{renderInline(h2[1], resolve)}</p>;
        if (h3) return <p key={i} className="font-medium text-lark-1 mt-3 mb-0.5">{renderInline(h3[1], resolve)}</p>;
        if (bullet) return <p key={i} className="flex gap-2 pl-2"><span className="shrink-0 text-lark-3">•</span><span>{renderInline(bullet[1], resolve)}</span></p>;
        if (line === "") return <br key={i} />;
        return <Fragment key={i}>{renderInline(line, resolve)}<br /></Fragment>;
      })}
    </>
  );
}
