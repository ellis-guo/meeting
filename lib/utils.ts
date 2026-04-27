export function addLineNumbers(transcript: string): string {
  const lines = transcript.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, i) => `[${i + 1}] ${line}`).join("\n");
}

export function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No valid JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}
