"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, Button, LoadingBlock, TextField } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** Only same-site paths are allowed as the place to go after signing in (no open redirect). */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

function LoginForm() {
  const { status, login } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "authenticated") router.replace(safeNext(params.get("next")));
  }, [status, params, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!username.trim() || !password) {
      setError("Enter your user name and password.");
      return;
    }
    setBusy(true);
    try {
      await login(username.trim(), password);
      router.replace(safeNext(params.get("next")));
    } catch (err) {
      // The server's message is the same whether the user exists or not. Keep what was typed, except the password.
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-control bg-brand" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-900" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16.5l8 4 8-4" />
            </svg>
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-600">Meridian Medical production tracking</p>
        </div>
        <form onSubmit={submit} noValidate className="space-y-4 rounded-panel border border-slate-200 bg-surface p-5">
          {params.get("expired") && !error && (
            <Alert kind="info">Your session ended. Please sign in again.</Alert>
          )}
          {error && <Alert kind="error">{error}</Alert>}
          <TextField label="User name" value={username} onChange={(e) => setUsername(e.target.value)}
            autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={50} autoFocus />
          <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" required maxLength={128} />
          <Button type="submit" loading={busy} className="w-full">Sign in</Button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-600">
          Accounts are created by an administrator. Demo prototype: not a certified medical manufacturing system.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LoginForm />
    </Suspense>
  );
}
