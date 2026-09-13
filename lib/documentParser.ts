// 参考文件 → 纯文本。
//
// 本地解析，不走云服务：文件里是会议材料和需求文档，送第三方 OCR/解析服务等于
// 把整个项目的上下文交出去，而 PDF/Word 的文本抽取本来就不需要模型。
//
// ⚠️ `pdf-parse@1.x` 不要用：它在 import 阶段就会去读包内的一个测试 PDF，
// 打包进 Next 之后那个文件不在，报的错跟业务毫无关系。这里用 `unpdf`（自带
// pdfjs，零运行时依赖）和 `mammoth`（docx → 纯文本）。
//
// 两个库都是**惰性 import**：pdfjs 有一兆多，Word 分支永远用不到它，
// 不该为了一个 .docx 把它加载进内存。

/**
 * 单个文件的大小上限。上传接口先挡一道，这里是第二道。
 *
 * ⚠️ 这个数字不是随便定的，它被 `proxyClientMaxBodySize` 卡着。项目有 `proxy.ts`，
 * 而 Next 在有 proxy 时会把请求体缓冲进内存，默认上限 10MB —— **超了不报错**，
 * 只把前 10MB 交给路由（见 next.config.ts 里的注释）。所以单文件上限必须显著
 * 小于那个配置值，否则用户传个大 PDF 会拿到一个"解析失败"而不是"文件太大"。
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 抽出来的文本长度上限。
 *
 * 不是为了省内存，是为了挡住"一份 800 页的 PDF 切出三千个 chunk"——embedding
 * 按量计费，而且这种文件混进检索池后会淹掉真正相关的会议内容。
 */
export const MAX_TEXT_CHARS = 300_000;

export type DocKind = "pdf" | "docx" | "text";

/** 解析失败里"重试也没用"的那一类，与网络/数据库故障区分开。 */
export class UnparseableDocument extends Error {}

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "log"]);

export function fileExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * 判断文件类型。**以扩展名为准，MIME 只作兜底**——浏览器给的 MIME 在 Windows
 * 上经常是空串或 `application/octet-stream`（取决于注册表里有没有登记），
 * 而扩展名是用户自己写的，至少稳定。
 */
export function detectKind(name: string, mimeType: string): DocKind | null {
  const ext = fileExtension(name);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (TEXT_EXTENSIONS.has(ext)) return "text";

  const mime = mimeType.toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mime.startsWith("text/")) return "text";
  return null;
}

/**
 * 部首补充区（U+2E80–U+2EFF）→ 正常汉字。
 *
 * 为什么需要：PDF 里的中文经常不是用正常码位存的，而是字体子集里的部首码位。
 * 实测本项目的一份 3 页 PDF，29 个字符落在兼容区，`text.includes("参会人员")`
 * 直接是 **false** —— 检索、jieba 分词、embedding 全都会静默对不上，而正文
 * 肉眼看完全正常，这种问题事后根本归因不到。
 *
 * NFKC 能解决绝大部分（康熙部首 U+2F00–U+2FDF 有兼容映射），但**部首补充区
 * 整块没有映射**，全块只有 U+2E9F(⺟→母) 和 U+2EF3(⻳→龟) 两个例外。所以这里
 * 手工补一张表。
 *
 * 只收**本身也是独立汉字**的那些：错映射会静默污染正文，比漏映射糟得多，
 * 而纯偏旁（⺅ ⺈ 之类）几乎不会单独出现在正文里，漏了也没有代价。
 */
const RADICAL_FALLBACK: Record<string, string> = {
  "⻅": "见", "⻆": "角", "⻉": "贝", "⻋": "车",
  "⻓": "长", "⻔": "门", "⻗": "雨", "⻘": "青",
  "⻚": "页", "⻛": "风", "⻜": "飞", "⻝": "食",
  "⻢": "马", "⻣": "骨", "⻤": "鬼", "⻥": "鱼",
  "⻦": "鸟", "⻨": "麦", "⻩": "黄", "⻬": "齐",
  "⻮": "齿", "⻰": "龙",
};

const RADICAL_RE = new RegExp(`[${Object.keys(RADICAL_FALLBACK).join("")}]`, "g");

/**
 * 不可见字符**按码位构造**正则，不写字面量。
 *
 * 字面量在编辑器和 diff 里完全看不出来，后来的人无从确认这个字符类里到底有什么；
 * 写成 \\uXXXX 转义也不保险——经手的编辑工具会把它还原成字面量。用 codePoint
 * 拼是唯一在源码里稳定可读的写法。
 */
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x200b, 0x200f], // 零宽空格 / 零宽连接符 / 左右书写标记
  [0x202a, 0x202e], // 双向控制符
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // BOM，也常出现在正文中间
];
/** 行分隔符 / 段分隔符。它们在 PDF 里就是换行的意思。 */
const LINE_SEPARATORS: Array<[number, number]> = [[0x2028, 0x2029]];

function charClass(ranges: Array<[number, number]>): RegExp {
  const body = ranges
    .map(([lo, hi]) =>
      lo === hi
        ? String.fromCodePoint(lo)
        : `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`,
    )
    .join("");
  return new RegExp(`[${body}]`, "g");
}

const INVISIBLE_RE = charClass(INVISIBLE_RANGES);
const LINE_SEPARATOR_RE = charClass(LINE_SEPARATORS);

/** 抽取结果的规范化。顺序有讲究：先 NFKC 统一码位，再补部首，最后收拾空白。 */
export function normalizeExtractedText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(RADICAL_RE, (ch) => RADICAL_FALLBACK[ch])
    // Word 和 Windows 下的 txt 是 CRLF
    .replace(/\r\n?/g, "\n")
    // 换成换行而不是删掉：删掉会把上下两行黏成一个词
    .replace(LINE_SEPARATOR_RE, "\n")
    // 零宽字符肉眼不可见，但会把词切断，jieba 分词和 embedding 都会因此对不上
    .replace(INVISIBLE_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    // PDF 每页页眉页脚之间常有大段空行，白白占 chunk 长度
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function extractDocx(data: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  // extractRawText 而不是 convertToHtml：进 RAG 的是纯文本，HTML 标签只会占
  // chunk 长度并污染 embedding。样式信息对检索没有价值。
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return value;
}

/**
 * 解析一个文件，返回规范化后的纯文本。
 *
 * 抛 `UnparseableDocument` = 这个文件本身就抽不出文本（扫描件、加密、坏文件、
 * 老版 .doc），**重试没有意义**，调用方应该直接把它记成失败而不是塞回队列。
 */
export async function extractDocumentText(
  data: Uint8Array,
  name: string,
  mimeType: string,
): Promise<{ kind: DocKind; text: string; truncated: boolean }> {
  if (data.byteLength === 0) throw new UnparseableDocument("文件是空的");
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new UnparseableDocument(`文件超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB 上限`);
  }

  const kind = detectKind(name, mimeType);
  if (!kind) {
    // .doc 单独说：mammoth 只吃 docx，而用户看到"不支持"第一反应是格式写错了
    const ext = fileExtension(name);
    if (ext === "doc") {
      throw new UnparseableDocument("不支持旧版 .doc，请用 Word 另存为 .docx 后再上传");
    }
    throw new UnparseableDocument(
      `不支持的文件类型${ext ? `（.${ext}）` : ""}，目前支持 PDF / Word(.docx) / 纯文本`,
    );
  }

  let raw: string;
  try {
    if (kind === "pdf") raw = await extractPdf(data);
    else if (kind === "docx") raw = await extractDocx(data);
    else raw = new TextDecoder("utf-8").decode(data);
  } catch (e) {
    // 库抛出来的异常一律归为"这个文件解不了"：pdfjs 对损坏/加密文件、mammoth
    // 对非 zip 内容都是直接抛，重试三次还是同样的结果，只会白烧队列。
    throw new UnparseableDocument(`解析失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const text = normalizeExtractedText(raw);
  if (!text) {
    throw new UnparseableDocument(
      kind === "pdf"
        ? "这份 PDF 里没有可抽取的文字，可能是扫描件（需要 OCR，暂不支持）"
        : "文件里没有可抽取的文字",
    );
  }

  const truncated = text.length > MAX_TEXT_CHARS;
  return { kind, text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated };
}
