"use client";

import { useState } from "react";
import { useSignUp } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Step = "form" | "verify";

export default function SignUpPage() {
  const { isLoaded, signUp, setActive } = useSignUp();
  const router = useRouter();

  const [step, setStep] = useState<Step>("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    setLoading(true);
    setError("");
    try {
      const result = await signUp.create({ emailAddress: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/");
      } else {
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setStep("verify");
      }
    } catch (err: unknown) {
      const clerkError = err as { errors?: { longMessage?: string; message: string }[] };
      const msg = clerkError?.errors?.[0]?.longMessage ?? clerkError?.errors?.[0]?.message;
      setError(msg ?? "注册失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    setLoading(true);
    setError("");
    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.push("/");
      } else {
        setError("验证未完成，请重试");
      }
    } catch (err: unknown) {
      const clerkError = err as { errors?: { longMessage?: string; message: string }[] };
      const msg = clerkError?.errors?.[0]?.longMessage ?? clerkError?.errors?.[0]?.message;
      setError(msg ?? "验证码错误，请重试");
    } finally {
      setLoading(false);
    }
  };

  const busy = loading;

  return (
    <div className="min-h-screen bg-lark-canvas flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        {/* Brand */}
        <div className="text-center space-y-1.5">
          <h1 className="text-xl font-semibold text-lark-1">更好用的会议管理助手</h1>
          <p className="text-sm text-lark-3">{step === "form" ? "创建账号" : "验证邮箱"}</p>
        </div>

        {step === "form" ? (
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
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-lark-2">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                required
                minLength={8}
                disabled={busy}
                className="w-full px-3.5 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-sunken text-lark-1 placeholder:text-lark-4 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 disabled:opacity-60 transition-colors"
              />
            </div>

            {error && <p className="text-xs text-lark-danger">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "注册中..." : "注册"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="bg-lark-surface rounded-2xl border border-lark-border shadow-card p-8 space-y-4">
            <p className="text-sm text-lark-2">
              验证码已发送至 <span className="font-medium text-lark-1">{email}</span>，请查收邮件。
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-lark-2">验证码</label>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="6 位数字"
                required
                autoFocus
                maxLength={6}
                disabled={busy}
                className="w-full px-3.5 py-2.5 border border-lark-border rounded-lg text-sm bg-lark-sunken text-lark-1 placeholder:text-lark-4 focus:outline-none focus:ring-2 focus:ring-lark-blue/40 disabled:opacity-60 transition-colors tracking-widest text-center font-mono"
              />
            </div>

            {error && <p className="text-xs text-lark-danger">{error}</p>}

            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "验证中..." : "验证并登录"}
            </button>

            <button
              type="button"
              onClick={() => { setStep("form"); setCode(""); setError(""); }}
              className="w-full text-sm text-lark-3 hover:text-lark-2 transition-colors"
            >
              返回修改邮箱
            </button>
          </form>
        )}

        <p className="text-center text-sm text-lark-3">
          已有账号？{" "}
          <Link href="/sign-in" className="text-lark-blue hover:underline">
            登录
          </Link>
        </p>
      </div>
    </div>
  );
}
