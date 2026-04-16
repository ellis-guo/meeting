export type SubItem = { text: string; source_lines: number[] };

export type TextContent = {
  type: "text";
  value: string;
  source_lines: number[];
};

export type BulletsContent = {
  type: "bullets";
  items: Array<{
    text: string;
    source_lines: number[];
    sub_items?: SubItem[];
  }>;
};

export type TableContent = {
  type: "table";
  columns: string[];
  rows: Array<{ cells: string[]; source_lines: number[] }>;
};

export type SectionContent = TextContent | BulletsContent | TableContent;

export type Section = {
  title: string;
  content: SectionContent;
};

export type Summary = {
  meta: { date: string | null; time: string | null; participants: string[] };
  sections: Section[];
  humanistic_note: string | null;
};

export type ProjectMemory = {
  overview: string | null;
  current_progress: string | null;
  key_decisions: Array<{ date: string; decision: string }>;
  open_issues: string[];
  next_meeting_goals: string | null;
};

export type DiffUpdate = {
  field: "current_progress" | "key_decisions" | "open_issues" | "next_meeting_goals" | "overview";
  old: unknown;
  new: unknown;
  reason: string;
};

export type DocumentDiff = {
  updates: DiffUpdate[];
};

export type Project = {
  id: string;
  name: string;
  created_at: string;
  document: ProjectMemory;
  meetings?: MeetingMeta[];
};

export type MeetingMeta = {
  id: string;
  created_at: string;
  summary: Summary;
  transcript?: string;
};
