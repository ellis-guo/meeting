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
        className="flex-1 resize-none rounded-lg border border-lark-border bg-lark-sunken px-3 py-2 text-sm text-lark-1 placeholder:text-lark-4 focus:outline-none focus:ring-1 focus:ring-lark-blue/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      />
      <button
        onClick={onSend}
        disabled={asking || !value.trim() || disabled}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-lark-blue text-white hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        <Send size={13} />
        {asking ? "思考中..." : "提问"}
      </button>
    </div>
  );
}
