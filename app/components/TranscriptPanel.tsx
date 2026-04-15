"use client";

interface Props {
  numberedTranscript: string;
  highlightedLines: number[];
}

function parseTranscript(raw: string) {
  return raw
    .split("\n")
    .map((line) => {
      const match = line.match(/^\[(\d+)\] (.*)$/);
      if (!match) return null;
      return { lineNum: parseInt(match[1]), content: match[2] };
    })
    .filter((l): l is { lineNum: number; content: string } => l !== null);
}

export default function TranscriptPanel({
  numberedTranscript,
  highlightedLines,
}: Props) {
  const lines = parseTranscript(numberedTranscript);
  const highlighted = new Set(highlightedLines);

  return (
    <div className="font-mono text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
      {lines.map(({ lineNum, content }) => (
        <div
          key={lineNum}
          id={`line-${lineNum}`}
          className={`flex gap-3 px-2 py-1 rounded transition-colors ${
            highlighted.has(lineNum)
              ? "bg-yellow-200 dark:bg-yellow-800/40 text-gray-900 dark:text-yellow-100"
              : "hover:bg-gray-50 dark:hover:bg-zinc-800"
          }`}
        >
          <span className="text-gray-300 dark:text-gray-600 select-none w-8 shrink-0 text-right">
            {lineNum}
          </span>
          <span className="leading-relaxed">{content}</span>
        </div>
      ))}
    </div>
  );
}
