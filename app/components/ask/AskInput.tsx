"use client";

import { type KeyboardEvent } from "react";
import { Send } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  asking: boolean;
  disabled?: boolean;
  placeholder: string;
}

/** 问答输入框 + 发送按钮。 */
export default function AskInput({
  value,
  onChange,
  onKeyDown,
  onSend,
  asking,
  disabled = false,
  placeholder,
}: Props) {
  return (
    <div className="flex gap-2 items-end">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={1}
        disabled={disabled}
        // rows={1} + resize-none 在窄屏上会把占位文字切掉半行：提示语一行放不下就
        // 换行，而框子不长高。手机上给两行的高度兜底（顺便是个更好按的触摸目标），
        // sm 及以上还原成一行。
        className="flex-1 min-w-0 min-h-14 sm:min-h-0 resize-none rounded-lg border border-tm-border bg-tm-sunken px-3 py-2 text-sm text-tm-1 placeholder:text-tm-4 focus:outline-none focus:ring-1 focus:ring-tm-brand/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      />
      <button
        onClick={onSend}
        disabled={asking || !value.trim() || disabled}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-tm-brand text-white hover:bg-tm-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        <Send size={13} />
        {asking ? "思考中..." : "提问"}
      </button>
    </div>
  );
}
