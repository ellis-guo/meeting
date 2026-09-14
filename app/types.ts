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

/** 线上 / 线下。判不出来就是 null——见 prompts.ts 里那条「不要猜」。 */
export type Modality = "online" | "offline";

export type Summary = {
  meta: {
    date: string | null;
    time: string | null;
    participants: string[];
    /**
     * 以下两个是 2026-09-14 才加的，**存量会议没有**（本地 40 场全是）。
     * 所以是可选的，渲染处必须能接受 undefined —— 不能拿日期或"未命名会议"
     * 顶上去，用户分不出那是「老数据没有」还是「模型没提取到」。
     */
    title?: string | null;
    modality?: Modality | null;
  };
  sections: Section[];
  humanistic_note: string | null;
};

export type Project = {
  id: string;
  name: string;
  created_at: string;
  meetings?: MeetingMeta[];
};

export type MeetingMeta = {
  id: string;
  created_at: string;
  summary: Summary;
  transcript?: string;
  processing_status?: "pending" | "processing" | "done" | "failed";
};
