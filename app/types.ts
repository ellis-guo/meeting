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
  goals: string[];
  members: Array<{ name: string; role: string }>;
  milestones: Array<{ date: string | null; title: string; status: "done" | "pending" }>;
  key_decisions: Array<{ date: string | null; decision: string; rationale: string | null }>;
  open_issues: Array<{ issue: string; owner: string | null; opened_at: string | null; resolved_at: string | null }>;
  risks: Array<{ risk: string; mitigation: string | null }>;
  glossary: Array<{ term: string; definition: string }>;
  checklist: Array<{ item: string; status: "done" | "pending" }>;
  [key: string]: unknown;
};

export type DiffUpdate = {
  field: "overview" | "goals" | "members" | "milestones" | "key_decisions" | "open_issues" | "risks" | "glossary" | "checklist";
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
  processing_status?: "pending" | "processing" | "done" | "failed";
  diff_status?: "pending" | "confirmed" | "dismissed" | null;
};
