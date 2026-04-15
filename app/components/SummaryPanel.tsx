"use client";

import {
  Summary,
  Section,
  SectionContent,
  BulletsContent,
  TableContent,
} from "../types";

interface Props {
  summary: Summary;
  isEditing: boolean;
  onSourceClick: (sourceLines: number[], x: number, y: number) => void;
  onSummaryChange: (updated: Summary) => void;
}

function EditableSpan({
  value,
  isEditing,
  onChange,
  className,
}: {
  value: string;
  isEditing: boolean;
  onChange: (val: string) => void;
  className?: string;
}) {
  if (!isEditing) return <span className={className}>{value}</span>;
  return (
    <span
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => {
        const val = e.currentTarget.textContent ?? "";
        if (val !== value) onChange(val);
      }}
      className={`${className ?? ""} outline-none border-b border-dashed border-blue-300 dark:border-blue-700 focus:border-blue-500 cursor-text`}
    >
      {value}
    </span>
  );
}

function TraceableText({
  text,
  sourceLines,
  isEditing,
  onChange,
  onSourceClick,
  className,
}: {
  text: string;
  sourceLines: number[];
  isEditing: boolean;
  onChange: (val: string) => void;
  onSourceClick: (sourceLines: number[], x: number, y: number) => void;
  className?: string;
}) {
  if (isEditing) {
    return (
      <EditableSpan
        value={text}
        isEditing={true}
        onChange={onChange}
        className={className}
      />
    );
  }
  return (
    <span
      className={`${className ?? ""} underline decoration-dotted decoration-blue-400 cursor-pointer hover:decoration-blue-500 hover:text-blue-700 dark:hover:text-blue-400 transition-colors`}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSourceClick(sourceLines, rect.left, rect.bottom + 4);
      }}
    >
      {text}
    </span>
  );
}

function Divider() {
  return <hr className="border-gray-100 dark:border-zinc-800 my-7" />;
}

function updateSection(
  summary: Summary,
  secIdx: number,
  updater: (s: Section) => Section
): Summary {
  return {
    ...summary,
    sections: summary.sections.map((s, i) => (i === secIdx ? updater(s) : s)),
  };
}

function ContentRenderer({
  content,
  secIdx,
  isEditing,
  onSourceClick,
  onSummaryChange,
  summary,
}: {
  content: SectionContent;
  secIdx: number;
  isEditing: boolean;
  onSourceClick: (sourceLines: number[], x: number, y: number) => void;
  onSummaryChange: (updated: Summary) => void;
  summary: Summary;
}) {
  if (content.type === "text") {
    return (
      <p className="pl-4 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
        <TraceableText
          text={content.value}
          sourceLines={content.source_lines}
          isEditing={isEditing}
          onChange={(val) =>
            onSummaryChange(
              updateSection(summary, secIdx, (s) => ({
                ...s,
                content: { ...s.content, value: val } as typeof content,
              }))
            )
          }
          onSourceClick={onSourceClick}
        />
      </p>
    );
  }

  if (content.type === "bullets") {
    return (
      <ul className="pl-4 space-y-3">
        {content.items.map((item, itemIdx) => (
          <li key={itemIdx}>
            <div className="flex gap-2.5 text-base font-medium leading-relaxed text-gray-800 dark:text-gray-200">
              <span className="text-gray-400 dark:text-gray-500 mt-0.5 shrink-0 tabular-nums">{itemIdx + 1}.</span>
              <TraceableText
                text={item.text}
                sourceLines={item.source_lines}
                isEditing={isEditing}
                onChange={(val) =>
                  onSummaryChange(
                    updateSection(summary, secIdx, (s) => ({
                      ...s,
                      content: {
                        ...(s.content as BulletsContent),
                        items: (s.content as BulletsContent).items.map((it, j) =>
                          j === itemIdx ? { ...it, text: val } : it
                        ),
                      },
                    }))
                  )
                }
                onSourceClick={onSourceClick}
              />
            </div>
            {item.sub_items && item.sub_items.length > 0 && (
              <ul className="pl-5 mt-1.5 space-y-1.5">
                {item.sub_items.map((sub, subIdx) => (
                  <li
                    key={subIdx}
                    className="flex gap-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400"
                  >
                    <span className="text-gray-300 dark:text-gray-600 mt-0.5 shrink-0">◦</span>
                    <TraceableText
                      text={sub.text}
                      sourceLines={sub.source_lines}
                      isEditing={isEditing}
                      onChange={(val) =>
                        onSummaryChange(
                          updateSection(summary, secIdx, (s) => ({
                            ...s,
                            content: {
                              ...(s.content as BulletsContent),
                              items: (s.content as BulletsContent).items.map(
                                (it, j) =>
                                  j === itemIdx
                                    ? {
                                        ...it,
                                        sub_items: it.sub_items?.map((sb, k) =>
                                          k === subIdx ? { ...sb, text: val } : sb
                                        ),
                                      }
                                    : it
                              ),
                            },
                          }))
                        )
                      }
                      onSourceClick={onSourceClick}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    );
  }

  if (content.type === "table") {
    return (
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 dark:border-zinc-700">
            {content.columns.map((col, i) => (
              <th
                key={i}
                className="text-left text-xs font-medium text-gray-400 dark:text-gray-500 pb-2 pr-6 last:pr-0"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {content.rows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className={`border-b border-gray-50 dark:border-zinc-900 transition-colors ${
                isEditing ? "" : "cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/50"
              }`}
              onClick={
                isEditing
                  ? undefined
                  : (e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      onSourceClick(row.source_lines, rect.left, rect.bottom + 4);
                    }
              }
            >
              {row.cells.map((cell, cellIdx) => (
                <td
                  key={cellIdx}
                  className={`py-2.5 pr-6 last:pr-0 align-top ${
                    cellIdx === 0
                      ? "font-medium text-gray-900 dark:text-gray-100"
                      : "text-gray-600 dark:text-gray-400"
                  }`}
                >
                  <EditableSpan
                    value={cell}
                    isEditing={isEditing}
                    onChange={(val) =>
                      onSummaryChange(
                        updateSection(summary, secIdx, (s) => ({
                          ...s,
                          content: {
                            ...(s.content as TableContent),
                            rows: (s.content as TableContent).rows.map((r, ri) =>
                              ri === rowIdx
                                ? {
                                    ...r,
                                    cells: r.cells.map((c, ci) =>
                                      ci === cellIdx ? val : c
                                    ),
                                  }
                                : r
                            ),
                          },
                        }))
                      )
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return null;
}

export default function SummaryPanel({
  summary,
  isEditing,
  onSourceClick,
  onSummaryChange,
}: Props) {
  const { date, time, participants } = summary.meta;
  const datetime = [date, time].filter(Boolean).join(" ") || "—";
  const attendees = participants.length > 0 ? participants.join("、") : "—";

  return (
    <div className="text-gray-800 dark:text-gray-200">
      {/* Meta */}
      <div className="mb-8 pb-6 border-b border-gray-100 dark:border-zinc-800 space-y-1.5 text-sm">
        <div className="flex gap-4">
          <span className="text-gray-400 dark:text-gray-500 shrink-0">会议时间</span>
          <EditableSpan
            value={datetime}
            isEditing={isEditing}
            onChange={(val) =>
              onSummaryChange({
                ...summary,
                meta: { ...summary.meta, date: val, time: null },
              })
            }
            className="text-gray-700 dark:text-gray-300"
          />
        </div>
        <div className="flex gap-4">
          <span className="text-gray-400 dark:text-gray-500 shrink-0">参会人员</span>
          <EditableSpan
            value={attendees}
            isEditing={isEditing}
            onChange={(val) =>
              onSummaryChange({
                ...summary,
                meta: {
                  ...summary.meta,
                  participants: val.split("、").map((s) => s.trim()).filter(Boolean),
                },
              })
            }
            className="text-gray-700 dark:text-gray-300"
          />
        </div>
      </div>

      {/* Sections */}
      {summary.sections.map((section, secIdx) => (
        <div key={secIdx}>
          {secIdx > 0 && <Divider />}
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">
            <EditableSpan
              value={section.title}
              isEditing={isEditing}
              onChange={(val) =>
                onSummaryChange(
                  updateSection(summary, secIdx, (s) => ({ ...s, title: val }))
                )
              }
            />
          </h2>
          <ContentRenderer
            content={section.content}
            secIdx={secIdx}
            isEditing={isEditing}
            onSourceClick={onSourceClick}
            onSummaryChange={onSummaryChange}
            summary={summary}
          />
        </div>
      ))}

      {/* Humanistic note */}
      {summary.humanistic_note && (
        <div className="mt-8 p-4 bg-blue-50 dark:bg-blue-950/40 rounded-lg text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
          <EditableSpan
            value={summary.humanistic_note}
            isEditing={isEditing}
            onChange={(val) =>
              onSummaryChange({ ...summary, humanistic_note: val })
            }
          />
        </div>
      )}
    </div>
  );
}
