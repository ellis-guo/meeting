export function addLineNumbers(transcript: string): string {
  const lines = transcript.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, i) => `[${i + 1}] ${line}`).join("\n");
}
