"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { X } from "lucide-react";
import { useApiKey } from "@/lib/ApiKeyContext";

export default function ApiKeyModal() {
  const pathname = usePathname();
  const { isLoaded, userId } = useAuth();
  const { modalOpen, closeModal, setApiKey } = useApiKey();
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!isLoaded || !userId) return null;
  if (!modalOpen) return null;
  if (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) return null;

  const handleSave = async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      setError("请输入 API Key");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setApiKey(trimmed);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setInput("");
    setError("");
    closeModal();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-lark-surface rounded-2xl p-8 max-w-md w-full space-y-6 relative" style={{ boxShadow: "var(--lark-shadow-modal)" }}>
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 text-lark-3 hover:text-lark-1 transition-colors"
        >
          <X size={16} />
        </button>

        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-lark-1">
            配置 DashScope API Key
          </h2>
          <p className="text-sm text-lark-2">
            使用本工具需要阿里云百炼 API Key。Key 加密存储，有效期 24 小时，不会存入开发者数据库。
          </p>
        </div>

        <div className="space-y-1.5">
          <input
            type="password"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && !saving && handleSave()}
            placeholder="sk-..."
            autoFocus
            disabled={saving}
            className="w-full px-4 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-sunken text-lark-1 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 placeholder:text-lark-4 font-mono disabled:opacity-60 transition-colors"
          />
          {error && <p className="text-xs text-lark-danger">{error}</p>}
        </div>

        <div className="space-y-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "保存中..." : "开始使用"}
          </button>
          <p className="text-xs text-center text-lark-3">
            在阿里云百炼控制台的「API-KEY」页面获取 Key
          </p>
        </div>
      </div>
    </div>
  );
}
