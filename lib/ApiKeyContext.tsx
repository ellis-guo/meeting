"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";

type KeyStatus = { configured: boolean; expiresAt: Date | null };

type ApiKeyContextValue = {
  status: KeyStatus;
  loading: boolean;
  setApiKey: (key: string) => Promise<void>;
  clearKey: () => Promise<void>;
};

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth();
  const [status, setStatus] = useState<KeyStatus>({ configured: false, expiresAt: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoaded) return; // 等 Clerk 初始化完成
    if (!userId) {
      setLoading(false); // 未登录，不发请求
      return;
    }

    fetch("/api/auth/api-key")
      .then((r) => r.json())
      .then((data) => {
        setStatus({
          configured: data.configured ?? false,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        });
      })
      .catch(() => setStatus({ configured: false, expiresAt: null }))
      .finally(() => setLoading(false));
  }, [isLoaded, userId]);

  const setApiKey = async (key: string) => {
    const res = await fetch("/api/auth/api-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error("会话已过期，请刷新页面重新登录");
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to save API key");
    setStatus({
      configured: true,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    });
  };

  const clearKey = async () => {
    await fetch("/api/auth/api-key", { method: "DELETE" });
    setStatus({ configured: false, expiresAt: null });
  };

  if (loading) return null;

  return (
    <ApiKeyContext.Provider value={{ status, loading, setApiKey, clearKey }}>
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKey(): ApiKeyContextValue {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) throw new Error("useApiKey must be used within ApiKeyProvider");
  return ctx;
}
