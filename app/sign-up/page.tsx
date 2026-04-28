"use client";

import { useState } from "react";
import { useSignUp } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignUpPage() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [topError, setTopError] = useState("");

  const busy = fetchStatus === "fetching";

  const needsVerification =
    signUp?.status === "missing_requirements" &&
    signUp.unverifiedFields?.includes("email_address") &&
    signUp.missingFields?.length === 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signUp) return;
    setTopError("");

    const { error } = await signUp.password({ emailAddress: email, password });
    if (error) {
      setTopError(error.longMessage ?? error.message ?? "注册失败，请重试");
      return;
    }

    await signUp.verifications.sendEmailCode();
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signUp) return;
    setTopError("");

    const { error } = await signUp.verifications.verifyEmailCode({ code });
    if (error) {
      setTopError(error.longMessage ?? error.message ?? "验证码错误，请重试");
      return;
    }

    if (signUp.status === "complete") {
      await signUp.finalize({
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
      setTopError("验证未完成，请重试");
    }
  };

  const resendCode = async () => {
    if (!signUp) return;
    setTopError("");
    await signUp.verifications.sendEmailCode();
  };

  const startOver = () => {
    setCode("");
    setTopError("");
    signUp?.reset?.();
  };

  return (
    <div className="min-h-screen bg-lark-canvas flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-1.5">
          <h1 className="text-xl font-semibold text-lark-1">更好用的会议管理助手</h1>
          <p className="text-sm text-lark-3">{needsVerification ? "验证邮箱" : "创建账号"}</p>
        </div>

        {!needsVerification ? (
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
              {errors?.fields?.emailAddress && (
                <p className="text-xs text-lark-danger">{errors.fields.emailAddress.message}</p>
              )}
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
              {busy ? "处理中..." : "注册"}
            </button>

            <div id="clerk-captcha" />
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
              {errors?.fields?.code && (
                <p className="text-xs text-lark-danger">{errors.fields.code.message}</p>
              )}
            </div>

            {topError && <p className="text-xs text-lark-danger">{topError}</p>}

            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="w-full py-2.5 bg-lark-blue text-white rounded-lg text-sm font-medium hover:bg-lark-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? "验证中..." : "验证并登录"}
            </button>

            <div className="flex justify-between text-xs">
              <button
                type="button"
                onClick={resendCode}
                disabled={busy}
                className="text-lark-blue hover:underline disabled:opacity-50"
              >
                重新发送验证码
              </button>
              <button
                type="button"
                onClick={startOver}
                disabled={busy}
                className="text-lark-3 hover:text-lark-2 disabled:opacity-50"
              >
                返回修改邮箱
              </button>
            </div>
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
