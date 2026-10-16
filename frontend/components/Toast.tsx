"use client";

import { createContext, useCallback, useContext, useState } from "react";

type Toast = { id: number; kind: "success" | "error"; message: string };
const ToastContext = createContext<(kind: Toast["kind"], message: string) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, message }]);
    // Errors stay a little longer: they usually need to be read and acted on
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === "error" ? 9000 : 5000);
  }, []);

  const dismiss = (id: number) => setToasts((current) => current.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-3 bottom-3 z-[80] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-control border px-3 py-2.5 text-sm shadow-md before:mt-0.5 before:inline-flex before:h-5 before:w-5 before:shrink-0 before:items-center before:justify-center before:rounded-full before:bg-current/10 before:text-xs before:font-bold ${
              toast.kind === "error"
                ? "border-red-200 bg-red-50 text-red-900 before:content-['✕']"
                : "border-emerald-200 bg-emerald-50 text-emerald-900 before:content-['✓']"
            }`}
          >
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            <button onClick={() => dismiss(toast.id)} aria-label="Dismiss message" title="Dismiss" className="-my-1 -mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-current opacity-70 hover:opacity-100">
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
