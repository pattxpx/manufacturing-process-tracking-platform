import { STATUS_LABELS, STEP_LABELS } from "@/lib/format";
import type { Order, OrderStatus, StepKey } from "@/lib/types";

// Each tone has its own text color AND a small symbol, so status is never shown by color alone.
// (The symbol is CSS-generated content, so it is not part of the badge text.)
const tones = {
  slate: "bg-slate-100 text-slate-800 ring-slate-300 before:content-['○']",
  blue: "bg-blue-50 text-blue-800 ring-blue-200 before:content-['●']",
  amber: "bg-amber-50 text-amber-900 ring-amber-300 before:content-['!']",
  red: "bg-red-50 text-red-800 ring-red-300 before:content-['✕']",
  violet: "bg-violet-50 text-violet-800 ring-violet-300 before:content-['◆']",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-300 before:content-['✓']",
};
export type Tone = keyof typeof tones;

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset before:text-[0.65rem] before:leading-none ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

const statusTone: Record<OrderStatus, Tone> = {
  new: "slate", in_production: "blue", awaiting_qc: "amber",
  qc_failed: "red", ready_for_release: "violet", released: "green",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={statusTone[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function StepBadge({ step }: { step: StepKey }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300">
      {STEP_LABELS[step]}
    </span>
  );
}

/** "Running" / "Waiting" / "Done" for the order's current step. */
export function StepStateBadge({ order }: { order: Order }) {
  if (order.status === "released") return <Badge tone="green">Done</Badge>;
  if (order.step_state === "running") return <Badge tone="blue">Running</Badge>;
  return <Badge tone="slate">Waiting</Badge>;
}

export function MachineBadge({ status }: { status: "idle" | "busy" }) {
  return status === "idle" ? <Badge tone="green">Available</Badge> : <Badge tone="amber">Busy</Badge>;
}

export function ResultBadge({ result }: { result: "pass" | "fail" }) {
  return result === "pass" ? <Badge tone="green">Pass</Badge> : <Badge tone="red">Fail</Badge>;
}
