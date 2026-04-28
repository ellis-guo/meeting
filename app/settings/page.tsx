"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import NotificationBell from "@/app/components/NotificationBell";
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
      toast.success("API Key 已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = () => {
    if (!window.confirm("确认清除 API Key？清除后将无法使用 AI 功能，直到重新配置。")) return;
    clearKey();
    toast.success("API Key 已清除");
  };

  const handleLangChange = async (next: Lang) => {
    setLang(next);
    setLangSaving(true);
    try {
      await fetch("/api/auth/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: next }),
      });
      toast.success("语言偏好已保存");
    } finally {
      setLangSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-lark-canvas">
      <header className="px-6 py-4 border-b border-lark-border bg-lark-surface flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-1.5 text-sm text-lark-2 hover:text-lark-1 transition-colors">
            <ArrowLeft size={14} />
            首页
          </Link>
          <span className="text-lark-border">|</span>
          <span className="text-sm font-medium text-lark-1">设置</span>
        </div>
        <NotificationBell />
      </header>

      <div className="max-w-lg mx-auto px-6 py-8 space-y-5">
        {/* API Key section */}
        <section className="bg-lark-surface rounded-xl border border-lark-border shadow-card p-6 space-y-5">
          <h2 className="text-sm font-semibold text-lark-1">DashScope API Key</h2>

          {status.configured ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-mono text-lark-1">已配置</p>
                  {status.expiresAt && (
                    <p className="text-xs text-lark-3">{formatExpiry(status.expiresAt)}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => { setChanging(true); setInput(""); setError(""); }}
                    className="text-sm text-lark-blue hover:underline"
                  >
                    更换
                  </button>
                  <button onClick={handleClearKey} className="text-sm text-lark-danger hover:underline">
                    清除
                  </button>
                </div>
              </div>

              {changing && (
                <div className="space-y-2 pt-4 border-t border-lark-border">
                  <input
                    type="password"
                    value={input}
                    onChange={(e) => { setInput(e.target.value); setError(""); }}
                    onKeyDown={(e) => e.key === "Enter" && !saving && handleSave()}
                    placeholder="输入新的 API Key"
                    autoFocus
                    disabled={saving}
                    className="w-full px-4 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-sunken text-lark-1 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 placeholder:text-lark-4 font-mono disabled:opacity-60"
                  />
                  {error && <p className="text-xs text-lark-danger">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-4 py-2 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 transition-colors"
                    >
                      {saving ? "保存中..." : "保存"}
                    </button>
                    <button
                      onClick={() => { setChanging(false); setError(""); }}
                      className="px-4 py-2 text-sm text-lark-2 hover:text-lark-1 transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-lark-2">未配置（应用无法使用）</p>
              <div className="space-y-2">
                <input
                  type="password"
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && !saving && handleSave()}
                  placeholder="输入 DashScope API Key"
                  disabled={saving}
                  className="w-full px-4 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-sunken text-lark-1 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 placeholder:text-lark-4 font-mono disabled:opacity-60"
                />
                {error && <p className="text-xs text-lark-danger">{error}</p>}
                <button
                  onClick={handleSave}
                  disabled={saving || !input.trim()}
                  className="px-4 py-2 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 transition-colors"
                >
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-lark-border">
            <p className="text-xs text-lark-3 leading-relaxed">
              API Key 经 AES-256-GCM 加密后存储在浏览器 HttpOnly Cookie 中，JavaScript
              无法读取。有效期 24 小时后自动清除。Key 不存入开发者数据库，仅在发起
              API 请求时由服务器临时解密调用。
            </p>
          </div>
        </section>

        {/* Language preference section */}
        <section className="bg-lark-surface rounded-xl border border-lark-border shadow-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-lark-1">主文档语言偏好</h2>
            {langSaving && <span className="text-xs text-lark-3">保存中...</span>}
          </div>

          <div className="space-y-2">
            {LANG_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  lang === opt.value
                    ? "border-lark-blue/40 bg-lark-blue-light"
                    : "border-lark-border hover:border-lark-border bg-lark-canvas"
                }`}
              >
                <input
                  type="radio"
                  name="lang"
                  value={opt.value}
                  checked={lang === opt.value}
                  onChange={() => handleLangChange(opt.value)}
                  className="mt-0.5 accent-[var(--lark-blue)]"
                />
                <div>
                  <p className="text-sm font-medium text-lark-1">{opt.label}</p>
                  <p className="text-xs text-lark-3 mt-0.5">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>

          <p className="text-xs text-lark-3 leading-relaxed pt-1 border-t border-lark-border">
            仅影响项目主文档的生成语言。会议摘要仍按转写稿主导语言自动判断。
          </p>
        </section>
      </div>
    </div>
  );
}
