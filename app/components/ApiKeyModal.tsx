"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useApiKey } from "@/lib/ApiKeyContext";

export default function ApiKeyModal() {
  const pathname = usePathname();
  const { isLoaded, userId } = useAuth();
  const { status, setApiKey } = useApiKey();
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!isLoaded || !userId) return null; // 未登录时不显示
  if (status.configured) return null;
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-8 max-w-md w-full space-y-6">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            配置 DashScope API Key
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            使用本工具需要阿里云百炼 API Key。Key 加密存储在浏览器 Cookie 中，有效期
            24 小时，不会存入开发者数据库。
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
            className="w-full px-4 py-2.5 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 font-mono disabled:opacity-60"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="space-y-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "保存中..." : "开始使用"}
          </button>
          <p className="text-xs text-center text-gray-400 dark:text-gray-500">
            在阿里云百炼控制台的「API-KEY」页面获取 Key
          </p>
        </div>
      </div>
    </div>
  );
}
