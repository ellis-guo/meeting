"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作用红色确认按钮。 */
  danger?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    // 同时只允许一个确认框：前一个还没回答就先当作取消。
    resolverRef.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  useEffect(() => {
    if (!options) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [options, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] print:hidden"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            className="bg-tm-surface rounded-xl p-6 max-w-sm w-full mx-4"
            style={{ boxShadow: "var(--tm-shadow-modal)" }}
          >
            <h2 className="text-sm font-semibold text-tm-1 mb-2">{options.title}</h2>
            {options.description && (
              <p className="text-sm text-tm-2 mb-5 leading-relaxed">{options.description}</p>
            )}
            <div className={`flex gap-3 justify-end ${options.description ? "" : "mt-5"}`}>
              <button
                onClick={() => close(false)}
                className="px-4 py-2 text-sm text-tm-2 hover:text-tm-1 transition-colors"
              >
                {options.cancelLabel ?? "取消"}
              </button>
              <button
                autoFocus
                onClick={() => close(true)}
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
                  options.danger
                    ? "bg-tm-danger hover:opacity-90"
                    : "bg-tm-brand hover:bg-tm-brand-hover"
                }`}
              >
                {options.confirmLabel ?? "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

/** 替代 window.confirm：`if (!(await confirm({ title }))) return;` */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
