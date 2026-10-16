"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Alert, Button, Card, PageHeader, TextField } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function AccountPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (next !== repeat) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/change-password", { method: "POST", body: { current_password: current, new_password: next } });
      toast("success", "Password changed. Other devices were signed out.");
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Your account" description={`${user?.full_name} · ${user?.username} · role: ${user?.role}`} />
      <Card title="Change password" description="Use at least 12 characters. A long phrase is better than a short complicated word." className="max-w-xl">
        <form onSubmit={submit} noValidate className="space-y-4">
          {error && <Alert kind="error">{error}</Alert>}
          <TextField label="Current password" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} maxLength={128} />
          <TextField label="New password" type="password" required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} maxLength={128} hint="At least 12 characters, and not containing your user name." />
          <TextField label="Repeat new password" type="password" required autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} maxLength={128} />
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>Change password</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
