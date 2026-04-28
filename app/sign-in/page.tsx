"use client";

import { useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignInPage() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [topError, setTopError] = useState("");

  const busy = fetchStatus === "fetching";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setTopError("");

    const { error } = await signIn.password({ emailAddress: email, password });
    if (error) {
      setTopError(error.longMessage ?? error.message ?? "邮箱或密码错误");
      return;
    }

    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: ({ decorateUrl }) => {
          const url = decorateUrl("/");
          if (url.startsWith("http")) {
            window.location.href = url;
          } else {
            router.push(url);
          }
        },
      });
    } else {
      setTopError("登录未完成，请重试");
    }
  };

  return (
    <div className="min-h-screen bg-lark-canvas flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-1.5">
          <h1 className="text-xl font-semibold text-lark-1">更好用的会议管理助手</h1>
          <p className="text-sm text-lark-3">登录以继续</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-lark-surface rounded-2xl border border-lark-border shadow-card p-8 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-lark-2">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
              disabled={busy}
              className="w-full px-3.5 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-sunken text-lark-1 placeholder:text-lark-4 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 disabled:opacity-60 transition-colors"
            />
            {errors?.fields?.identifier && (
              <p className="text-xs text-lark-danger">{errors.fields.identifier.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-lark-2">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={busy}
              className="w-full px-3.5 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-sunken text-lark-1 placeholder:text-lark-4 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 disabled:opacity-60 transition-colors"
            />
            {errors?.fields?.password && (
              <p className="text-xs text-lark-danger">{errors.fields.password.message}</p>
            )}
          </div>

          {topError && <p className="text-xs text-lark-danger">{topError}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? "登录中..." : "登录"}
          </button>
        </form>

        <p className="text-center text-sm text-lark-3">
          还没有账号？{" "}
          <Link href="/sign-up" className="text-lark-blue hover:underline">
            注册
          </Link>
        </p>
      </div>
    </div>
  );
}
