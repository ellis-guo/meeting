"use client";

/**
 * 手机上在两个并排面板之间切换的标签条。
 *
 * 会议详情是「摘要 | 逐字稿」的等宽双栏，375px 屏上每栏只剩约 187px，两边都没法
 * 读。手机上改成一次只显示一栏、占满宽度，由这条标签切换；`md:` 及以上不渲染
 * （那时两栏并排，没有"切换"这回事），打印时也不出现。
 *
 * 面板自身的显隐留在各页面里写——两个页面的右栏结构不一样，硬塞进来反而绕。
 */
export default function PanelTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: ReadonlyArray<{ key: string; label: string }>;
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex md:hidden border-b border-lark-border shrink-0 print:hidden"
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
            value === t.key
              ? "text-lark-blue border-b-2 border-lark-blue"
              : "text-lark-3 border-b-2 border-transparent hover:text-lark-2"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
