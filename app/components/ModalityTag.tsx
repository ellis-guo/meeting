import type { Modality } from "@/app/types";

/**
 * 线上 / 线下标签（PRD 4.3）。
 *
 * ⚠️ `modality` 为 null / undefined 时**什么都不渲染**，不出"未知"之类的占位。
 * 两种情况会落到 null：2026-09-14 之前的存量会议压根没有这个字段；以及模型
 * 在没有明确证据时按 prompt 要求填了 null。这两种都不该在界面上变成一个
 * 看起来像结论的标签——错的线上/线下和对的长得一模一样，用户分辨不出来。
 */
export default function ModalityTag({ modality }: { modality?: Modality | null }) {
  if (!modality) return null;
  const online = modality === "online";
  return (
    <span
      className={`text-[10px] leading-none px-1.5 py-1 rounded border shrink-0 ${
        online
          ? "border-tm-brand/30 text-tm-brand bg-tm-brand-light"
          : "border-tm-border text-tm-2 bg-tm-sunken"
      }`}
    >
      {online ? "线上" : "线下"}
    </span>
  );
}
