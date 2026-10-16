"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setCsrfToken } from "./api";
import { setDisplayTimeZone } from "./format";

export interface CurrentUser { id: number; username: string; full_name: string; role: string }
interface Me { user: CurrentUser; permissions: string[]; csrf_token: string; timezone: string }

interface AuthValue {
  status: "loading" | "anonymous" | "authenticated";
  user: CurrentUser | null;
  timezone: string;
  /** Hides buttons the user may not use. This is only for convenience: the backend decides what is allowed. */
  can: (permission: string) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthValue["status"]>("loading");
  const router = useRouter();
  const pathname = usePathname();

  const accept = useCallback((value: Me) => {
    setCsrfToken(value.csrf_token);
    setDisplayTimeZone(value.timezone);
    setMe(value);
    setStatus("authenticated");
  }, []);

  const forget = useCallback(() => {
    setCsrfToken(null);
    setMe(null);
    setStatus("anonymous");
  }, []);

  // Who am I? (asks the server: the cookie itself cannot be read by scripts)
  useEffect(() => {
    api<Me>("/api/auth/me").then(accept).catch(forget);
  }, [accept, forget]);

  // Any API call that comes back 401 means the session ended
  useEffect(() => {
    const onExpired = () => {
      forget();
      if (pathname !== "/login") router.replace(`/login?next=${encodeURIComponent(pathname)}&expired=1`);
    };
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, [forget, pathname, router]);

  const login = useCallback(async (username: string, password: string) => {
    accept(await api<Me>("/api/auth/login", { method: "POST", body: { username, password } }));
  }, [accept]);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      forget();
      router.replace("/login");
    }
  }, [forget, router]);

  const value = useMemo<AuthValue>(() => ({
    status,
    user: me?.user ?? null,
    timezone: me?.timezone ?? "UTC",
    can: (permission) => !!me?.permissions.includes(permission),
    login,
    logout,
  }), [status, me, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
