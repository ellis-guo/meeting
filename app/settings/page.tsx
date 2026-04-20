"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useApiKey } from "@/lib/ApiKeyContext";

function formatExpiry(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "已过期";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟后过期`;
  return `${minutes} 分钟后过期`;
}

type Lang = "zh" | "en";

const LANG_OPTIONS: { value: Lang; label: string; desc: string }[] = [
  { value: "zh", label: "中文", desc: "以中文为主，学术名词/代码标识符保留英文" },
  { value: "en", label: "English", desc: "English-first, retain original technical terms" },
];

export default function SettingsPage() {
  const { status, setApiKey, clearKey } = useApiKey();
  const [changing, setChanging] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [lang, setLang] = useState<Lang>("zh");
  const [langSaving, setLangSaving] = useState(false);
  const [langSaved, setLangSaved] = useState(false);

  useEffect(() => {
    fetch("/api/auth/preferences")
      .then((r) => r.json())
      .then((data) => { if (data.lang) setLang(data.lang as Lang); })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    const trimmed = input.trim();
    if (!trimmed) { setError("请输入 API Key"); return; }
    setSaving(true);
    setError("");
    try {
      await setApiKey(trimmed);
      setChanging(false);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleLangChange = async (next: Lang) => {
    setLang(next);
    setLangSaving(true);
    setLangSaved(false);
    try {
      await fetch("/api/auth/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: next }),
      });
      setLangSaved(true);
      setTimeout(() => setLangSaved(false), 2000);
    } finally {
      setLangSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950">
      <header className="px-8 py-5 border-b border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center gap-3">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
          ← 首页
        </Link>
        <span className="text-gray-200 dark:text-zinc-700">|</span>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">设置</span>
      </header>

      <div className="max-w-lg mx-auto px-8 py-10 space-y-6">
        {/* API Key section */}
        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 p-6 space-y-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">DashScope API Key</h2>

          {status.configured ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-mono text-gray-700 dark:text-gray-300">已配置</p>
                  {status.expiresAt && (
                    <p className="text-xs text-gray-400">{formatExpiry(status.expiresAt)}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => { setChanging(true); setInput(""); setError(""); }}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    更换
                  </button>
                  <button onClick={clearKey} className="text-sm text-red-500 dark:text-red-400 hover:underline">
                    清除
                  </button>
                </div>
              </div>

              {changing && (
                <div className="space-y-2 pt-4 border-t border-gray-100 dark:border-zinc-800">
                  <input
                    type="password"
                    value={input}
                    onChange={(e) => { setInput(e.target.value); setError(""); }}
                    onKeyDown={(e) => e.key === "Enter" && !saving && handleSave()}
                    placeholder="输入新的 API Key"
                    autoFocus
                    disabled={saving}
                    className="w-full px-4 py-2.5 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 font-mono disabled:opacity-60"
                  />
                  {error && <p className="text-xs text-red-500">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {saving ? "保存中..." : "保存"}
                    </button>
                    <button
                      onClick={() => { setChanging(false); setError(""); }}
                      className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400">未配置（应用无法使用）</p>
              <div className="space-y-2">
                <input
                  type="password"
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && !saving && handleSave()}
                  placeholder="输入 DashScope API Key"
                  disabled={saving}
                  className="w-full px-4 py-2.5 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 font-mono disabled:opacity-60"
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
                <button
                  onClick={handleSave}
                  disabled={saving || !input.trim()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-gray-100 dark:border-zinc-800">
            <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
              API Key 经 AES-256-GCM 加密后存储在浏览器 HttpOnly Cookie 中，JavaScript
              无法读取。有效期 24 小时后自动清除。Key 不存入开发者数据库，仅在发起
              API 请求时由服务器临时解密调用。
            </p>
          </div>
        </section>

        {/* Language preference section */}
        <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">主文档语言偏好</h2>
            {langSaving && <span className="text-xs text-gray-400">保存中...</span>}
            {langSaved && !langSaving && <span className="text-xs text-green-500">已保存</span>}
          </div>

          <div className="space-y-2">
            {LANG_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  lang === opt.value
                    ? "border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-950/20"
                    : "border-gray-200 dark:border-zinc-700 hover:border-gray-300 dark:hover:border-zinc-600"
                }`}
              >
                <input
                  type="radio"
                  name="lang"
                  value={opt.value}
                  checked={lang === opt.value}
                  onChange={() => handleLangChange(opt.value)}
                  className="mt-0.5 text-blue-600"
                />
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{opt.label}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed pt-1 border-t border-gray-100 dark:border-zinc-800">
            仅影响项目主文档的生成语言。会议摘要仍按转写稿主导语言自动判断。
          </p>
        </section>
      </div>
    </div>
  );
}
