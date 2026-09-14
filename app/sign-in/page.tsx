"use client";

import { useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";

// 第二因子：既包括账号自己开的两步验证，也包括 Clerk 的「新设备验证」
// （Two-step verification 在 Dashboard 里关着也会触发，走 email_code）。
type Factor = "email_code" | "phone_code" | "totp" | "backup_code";

const FACTOR_UI: Record<Factor, { title: string; hint: string; placeholder: string }> = {
  email_code: { title: "验证你的邮箱", hint: "我们已把验证码发到你的邮箱", placeholder: "6 位验证码" },
  phone_code: { title: "验证你的手机", hint: "我们已把验证码发到你的手机", placeholder: "6 位验证码" },
  totp: { title: "两步验证", hint: "打开认证器 App，输入当前的动态码", placeholder: "6 位动态码" },
  backup_code: { title: "使用备份码", hint: "输入你保存的其中一个备份码", placeholder: "备份码" },
};

// 自动挑一个第二因子时的优先级；backup_code 放最后，它是兜底手段。
const FACTOR_PRIORITY: Factor[] = ["totp", "email_code", "phone_code", "backup_code"];

// signIn.status 不为 complete 又不是第二因子时，把卡在哪一步说清楚。
// 以前统一吞成"登录未完成，请重试"，排查时完全没线索。
const STATUS_HINT: Record<string, string> = {
  needs_identifier: "邮箱未被识别，请检查后重试",
  needs_first_factor: "还需完成一次身份验证（该账号可能没开启密码登录）",
  needs_new_password: "Clerk 要求先重设密码才能登录",
  needs_client_trust: "未通过人机验证（Clerk 机器人防护），请刷新页面重试",
};

export default function SignInPage() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factor, setFactor] = useState<Factor | null>(null);
  const [topError, setTopError] = useState("");

  const busy = fetchStatus === "fetching";

  // Clerk 会把错误分派到 errors.fields（字段级，渲染在各输入框下面）和
  // errors.global（解析不出字段归属的）。这里只补应用自己的本地文案，
  // 不再手动存一份 Clerk 错误，否则同一句会在字段下和表单底部各显示一次。
  const formError = errors?.global?.[0]?.message ?? topError;

  const finish = async () => {
    if (!signIn) return;
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
  };

  const startSecondFactor = async () => {
    if (!signIn) return;
    const available = signIn.supportedSecondFactors.map((f) => f.strategy);
    // 新设备验证只会给 email_code；真开了 2FA 的账号可能给 totp / backup_code
    const picked = FACTOR_PRIORITY.find((f) => available.includes(f)) ?? "email_code";

    if (picked === "email_code") {
      const { error } = await signIn.mfa.sendEmailCode();
      if (error) return;
    } else if (picked === "phone_code") {
      const { error } = await signIn.mfa.sendPhoneCode();
      if (error) return;
    }

    setCode("");
    setFactor(picked);
  };

  // 每一步验证之后都走这里，根据新的 status 决定下一步
  const advance = async () => {
    if (!signIn) return;
    if (signIn.status === "complete") {
      await finish();
      return;
    }
    if (signIn.status === "needs_second_factor") {
      await startSecondFactor();
      return;
    }
    const s = signIn.status;
    setTopError(`${STATUS_HINT[s] ?? "登录未完成，请重试"}（status: ${s}）`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn) return;
    setTopError("");

    const { error } = await signIn.password({ emailAddress: email, password });
    if (error) return;

    await advance();
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn || !factor) return;
    setTopError("");

    const { error } =
      factor === "totp"
        ? await signIn.mfa.verifyTOTP({ code })
        : factor === "backup_code"
          ? await signIn.mfa.verifyBackupCode({ code })
          : factor === "phone_code"
            ? await signIn.mfa.verifyPhoneCode({ code })
            : await signIn.mfa.verifyEmailCode({ code });
    if (error) return;

    await advance();
  };

  const resend = async () => {
    if (!signIn) return;
    setTopError("");
    if (factor === "email_code") await signIn.mfa.sendEmailCode();
    else if (factor === "phone_code") await signIn.mfa.sendPhoneCode();
  };

  const backToPassword = async () => {
    setTopError("");
    setCode("");
    setFactor(null);
    await signIn?.reset();
  };

  const inputClass =
    "w-full px-3.5 py-2.5 border border-tm-border rounded-lg text-sm bg-tm-sunken text-tm-1 placeholder:text-tm-4 focus:outline-none focus:ring-2 focus:ring-tm-brand/40 disabled:opacity-60 transition-colors";
  const submitClass =
    "w-full py-2.5 bg-tm-brand text-white rounded-lg text-sm font-medium hover:bg-tm-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="min-h-screen bg-tm-canvas flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-1.5">
          <h1 className="text-xl font-semibold text-tm-1">更好用的会议管理助手</h1>
          <p className="text-sm text-tm-3">
            {factor ? FACTOR_UI[factor].hint : "登录以继续"}
          </p>
        </div>

        {factor ? (
          <form
            onSubmit={handleVerify}
            className="bg-tm-surface rounded-2xl border border-tm-border shadow-card p-8 space-y-4"
          >
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-tm-2">{FACTOR_UI[factor].title}</label>
              <input
                type="text"
                inputMode={factor === "backup_code" ? "text" : "numeric"}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={FACTOR_UI[factor].placeholder}
                required
                autoFocus
                disabled={busy}
                className={inputClass}
              />
              {errors?.fields?.code && (
                <p className="text-xs text-tm-danger">{errors.fields.code.message}</p>
              )}
            </div>

            {formError && <p className="text-xs text-tm-danger">{formError}</p>}

            <button type="submit" disabled={busy} className={submitClass}>
              {busy ? "验证中..." : "验证并登录"}
            </button>

            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={backToPassword}
                className="text-tm-3 hover:text-tm-1 transition-colors"
              >
                返回
              </button>
              {(factor === "email_code" || factor === "phone_code") && (
                <button
                  type="button"
                  onClick={resend}
                  disabled={busy}
                  className="text-tm-brand hover:underline disabled:opacity-50"
                >
                  重新发送
                </button>
              )}
            </div>
          </form>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-tm-surface rounded-2xl border border-tm-border shadow-card p-8 space-y-4"
          >
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-tm-2">邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                disabled={busy}
                className={inputClass}
              />
              {errors?.fields?.identifier && (
                <p className="text-xs text-tm-danger">{errors.fields.identifier.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-tm-2">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={busy}
                className={inputClass}
              />
              {errors?.fields?.password && (
                <p className="text-xs text-tm-danger">{errors.fields.password.message}</p>
              )}
            </div>

            {/* 自定义登录流程下，Clerk 的机器人防护需要页面上有这个挂载点，
                否则可能卡在 needs_client_trust。没开防护时它不渲染任何东西。 */}
            <div id="clerk-captcha" />

            {formError && <p className="text-xs text-tm-danger">{formError}</p>}

            <button type="submit" disabled={busy} className={submitClass}>
              {busy ? "登录中..." : "登录"}
            </button>
          </form>
        )}

        {!factor && (
          <p className="text-center text-sm text-tm-3">
            还没有账号？{" "}
            <Link href="/sign-up" className="text-tm-brand hover:underline">
              注册
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
