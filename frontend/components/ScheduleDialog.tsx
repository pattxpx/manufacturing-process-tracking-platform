"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { utcToZonedInput, zonedInputToUtcIso } from "@/lib/format";
import type { SchedulePrinter } from "@/lib/types";
import { Dialog } from "./Dialog";
import { Select } from "./Select";
import { Alert, Button, TextField } from "./ui";

export interface PlanTarget {
  id: number; order_number: string; product: string;
  current?: { machine_id: number; planned_start_at: string; estimated_duration_minutes: number };
}

/** Plan (or re-plan) a print job: printer, start time and an estimated duration. The server checks every rule. */
export function ScheduleDialog({ target, printers, onClose, onSaved }: {
  target: PlanTarget; printers: SchedulePrinter[]; onClose: () => void; onSaved: () => void;
}) {
  const { timezone } = useAuth();
  const [machine, setMachine] = useState(String(target.current?.machine_id ?? printers[0]?.id ?? ""));
  // A new plan starts at the next full hour. (A lazy initial value runs once, so the clock is read only once.)
  const [start, setStart] = useState(() => target.current
    ? utcToZonedInput(target.current.planned_start_at, timezone)
    : utcToZonedInput(new Date(Date.now() + 3600_000).toISOString(), timezone).slice(0, 14) + "00");
  const [minutes, setMinutes] = useState(String(target.current?.estimated_duration_minutes ?? 60));
  const [errors, setErrors] = useState<{ start?: string; minutes?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setServerError(null);
    const found: typeof errors = {};
    if (!start) found.start = "Choose the planned start.";
    const duration = Number(minutes);
    if (!Number.isInteger(duration) || duration < 1 || duration > 10080) found.minutes = "Enter whole minutes, from 1 to 10,080 (7 days).";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await api(`/api/orders/${target.id}/schedule`, {
        method: "PUT",
        body: { machine_id: Number(machine), planned_start_at: zonedInputToUtcIso(start, timezone), estimated_duration_minutes: duration },
      });
      onSaved();
    } catch (err) {
      setServerError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`${target.current ? "Reschedule" : "Plan"} ${target.order_number}`}
      description={`${target.product}. This is a plan only: it does not start anything or reserve material.`}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} onClick={save}>{target.current ? "Save new plan" : "Save plan"}</Button></>}
    >
      <Select label="Printer" required value={machine} onChange={setMachine}
        options={printers.map((p) => ({ value: String(p.id), label: p.name, hint: p.status === "busy" ? `Busy now with ${p.current_order_number ?? "a job"}` : "Free now" }))} />
      <TextField label={`Planned start (${timezone})`} required type="datetime-local" value={start}
        onChange={(e) => setStart(e.target.value)} error={errors.start} />
      <TextField label="Estimated duration (minutes)" required type="number" inputMode="numeric" min={1} max={10080}
        value={minutes} onChange={(e) => setMinutes(e.target.value)} error={errors.minutes}
        hint="Your own estimate. It is not read from the printer." />
      {serverError && <Alert kind="error" title="This plan cannot be saved">{serverError}</Alert>}
    </Dialog>
  );
}
