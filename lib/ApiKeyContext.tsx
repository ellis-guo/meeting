"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";

type KeyStatus = { configured: boolean; expiresAt: Date | null };

type ApiKeyContextValue = {
  status: KeyStatus;
  loading: boolean;
  modalOpen: boolean;
  promptApiKey: () => void;
  closeModal: () => void;
  setApiKey: (key: string) => Promise<void>;
  clearKey: () => Promise<void>;
};

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth();
  const [status, setStatus] = useState<KeyStatus>({ configured: false, expiresAt: null });
  const [fetched, setFetched] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // loading 由状态推导，不在 effect 里同步 setState（React 19 会因级联渲染报错）
  const loading = !isLoaded || (!!userId && !fetched);

  useEffect(() => {
    if (!isLoaded || !userId) return;
    let cancelled = false;

    fetch("/api/auth/api-key")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setStatus({
          configured: data.configured ?? false,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        });
      })
      .catch(() => {
        if (!cancelled) setStatus({ configured: false, expiresAt: null });
      })
      .finally(() => {
        if (!cancelled) setFetched(true);
      });

    return () => { cancelled = true; };
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
    setModalOpen(false);
  };

  const clearKey = async () => {
    await fetch("/api/auth/api-key", { method: "DELETE" });
    setStatus({ configured: false, expiresAt: null });
  };

  return (
    <ApiKeyContext.Provider value={{
      status,
      loading,
      modalOpen,
      promptApiKey: () => setModalOpen(true),
      closeModal: () => setModalOpen(false),
      setApiKey,
      clearKey,
    }}>
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKey(): ApiKeyContextValue {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) throw new Error("useApiKey must be used within ApiKeyProvider");
  return ctx;
}
