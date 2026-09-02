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
      className={`${className ?? ""} outline-none border-b border-dashed border-lark-blue/50 focus:border-lark-blue cursor-text`}
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
      className={`${className ?? ""} underline decoration-dotted decoration-lark-blue/50 cursor-pointer hover:decoration-lark-blue hover:text-lark-blue transition-colors`}
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
  return <hr className="border-lark-border my-6" />;
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
      <p className="pl-4 text-sm leading-relaxed text-lark-2">
        <EditableSpan
          value={content.value}
          isEditing={isEditing}
          onChange={(val) =>
            onSummaryChange(
              updateSection(summary, secIdx, (s) => ({
                ...s,
                content: { ...s.content, value: val } as typeof content,
              }))
            )
          }
        />
      </p>
    );
  }

  if (content.type === "bullets") {
    return (
      <ul className="pl-4 space-y-3">
        {content.items.map((item, itemIdx) => (
          <li key={itemIdx}>
            <div className="flex gap-2.5 text-sm font-medium leading-relaxed text-lark-1">
              <span className="text-lark-3 mt-0.5 shrink-0 tabular-nums">{itemIdx + 1}.</span>
              {item.sub_items && item.sub_items.length > 0 ? (
                <EditableSpan
                  value={item.text}
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
                />
              ) : (
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
              )}
            </div>
            {item.sub_items && item.sub_items.length > 0 && (
              <ul className="pl-5 mt-1.5 space-y-1.5">
                {item.sub_items.map((sub, subIdx) => (
                  <li
                    key={subIdx}
                    className="flex gap-2 text-sm leading-relaxed text-lark-2"
                  >
                    <span className="text-lark-4 mt-0.5 shrink-0">◦</span>
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
          <tr className="border-b border-lark-border">
            {content.columns.map((col, i) => (
              <th
                key={i}
                className="text-left text-xs font-medium text-lark-3 pb-2 pr-6 last:pr-0"
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
              className={`border-b border-lark-border/50 transition-colors ${
                isEditing ? "" : "cursor-pointer hover:bg-lark-sunken"
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
                      ? "font-medium text-lark-1"
                      : "text-lark-2"
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
    <div className="text-lark-1">
      {/* Meta */}
      <div className="mb-7 pb-5 border-b border-lark-border space-y-1.5 text-sm">
        <div className="flex gap-4">
          <span className="text-lark-3 shrink-0">会议时间</span>
          {isEditing ? (
            // 日期和时间必须分开编辑。合成一个字符串编辑会把 "2026-04-09 10:00"
            // 整串写回 meta.date，而 meta.date 是 chunk.meeting_date、日期路由、
            // diff 的 opened_at 的唯一来源，格式一坏全链路都受影响。
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={date ?? ""}
                onChange={(e) =>
                  onSummaryChange({
                    ...summary,
                    meta: { ...summary.meta, date: e.target.value || null },
                  })
                }
                className="px-2 py-0.5 rounded-md border border-lark-border bg-lark-surface text-lark-1 text-sm focus:outline-none focus:ring-2 focus:ring-lark-blue/40"
              />
              <input
                type="text"
                value={time ?? ""}
                placeholder="开始时间（选填）"
                onChange={(e) =>
                  onSummaryChange({
                    ...summary,
                    meta: { ...summary.meta, time: e.target.value || null },
                  })
                }
                className="px-2 py-0.5 w-32 rounded-md border border-lark-border bg-lark-surface text-lark-1 text-sm placeholder:text-lark-4 focus:outline-none focus:ring-2 focus:ring-lark-blue/40"
              />
            </div>
          ) : (
            <span className="text-lark-1">{datetime}</span>
          )}
        </div>
        <div className="flex gap-4">
          <span className="text-lark-3 shrink-0">参会人员</span>
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
            className="text-lark-1"
          />
        </div>
      </div>

      {/* Sections */}
      {summary.sections.map((section, secIdx) => (
        <div key={secIdx}>
          {secIdx > 0 && <Divider />}
          <h2 className="text-base font-semibold text-lark-1 mb-3">
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
        <div className="mt-7 p-4 bg-lark-blue-light rounded-lg text-sm text-lark-blue leading-relaxed print:hidden">
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
