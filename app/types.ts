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
