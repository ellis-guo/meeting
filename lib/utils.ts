/**
 * 行号基准的唯一定义：过滤空行，剩下的从 1 开始编号。
 *
 * 这一个定义同时约束四件事——喂给模型的带号原文（addLineNumbers）、校验模型
 * 回填的 source_lines（numberedLineCount）、逐字稿切块的 line_start/line_end
 * （buildTranscriptChunks）、以及 rechunk 的重切。四者只要有一处对不齐，溯源
 * 跳转就整体错位。原先是四份各自的 split+filter 靠注释互相约束，现在靠调用。
 */
export function numberedLines(transcript: string): string[] {
  return transcript.split("\n").filter((line) => line.trim() !== "");
}

export function addLineNumbers(transcript: string): string {
  return numberedLines(transcript).map((line, i) => `[${i + 1}] ${line}`).join("\n");
}

/** 模型可以引用到的最大行号。见 numberedLines。 */
export function numberedLineCount(transcript: string): number {
  return numberedLines(transcript).length;
}

export function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No valid JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}
