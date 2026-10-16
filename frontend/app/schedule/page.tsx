"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, MachineBadge } from "@/components/Badge";
import { ConfirmDialog } from "@/components/Dialog";
import { type PlanTarget, ScheduleDialog } from "@/components/ScheduleDialog";
import { ScheduleTimeline } from "@/components/ScheduleTimeline";
import { Select } from "@/components/Select";
import { useToast } from "@/components/Toast";
import {
  Alert, Button, Card, EmptyState, LoadingBlock, PageHeader, Table, Tbody, Td, Th, Thead, Tr,
} from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatPlanTime, STEP_LABELS } from "@/lib/format";
import { useLiveData } from "@/lib/hooks";
import type { Schedule, ScheduleState } from "@/lib/types";

const tone: Record<ScheduleState, "slate" | "blue" | "amber" | "green"> = {
  planned: "slate", running: "blue", delayed: "amber", completed: "green",
};
const label: Record<ScheduleState, string> = { planned: "Planned", running: "Running", delayed: "Delayed", completed: "Completed" };
const DAY = 24 * 3600_000;

export default function SchedulePage() {
  const { can } = useAuth();
  const toast = useToast();
  const [days, setDays] = useState("3");
  const [start, setStart] = useState<string | null>(null); // null = a few hours before now
  const { data, error, loading, refreshing, reload } = useLiveData(() => {
    const query = new URLSearchParams({ days });
    if (start) query.set("start", start);
    return api<Schedule>(`/api/schedule?${query}`);
  }, [days, start]);

  const [planning, setPlanning] = useState<PlanTarget | null>(null);
  const [removing, setRemoving] = useState<{ id: number; order_number: string } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const canManage = can("schedule:manage");

  function shift(direction: -1 | 1) {
    if (!data) return;
    setStart(new Date(new Date(data.window_start).getTime() + direction * Number(days) * DAY).toISOString());
  }

  async function removePlan() {
    if (!removing) return;
    try {
      await api(`/api/orders/${removing.id}/schedule`, { method: "DELETE" });
      toast("success", `Plan removed for ${removing.order_number}`);
      setRemoving(null);
      reload();
    } catch (err) {
      setRemoveError(errorText(err));
    }
  }

  const jobs = data?.printers.flatMap((p) => p.jobs.map((job) => ({ ...job, printer: p.name }))) ?? [];

  return (
    <>
      <PageHeader
        title="Schedule"
        description="Plan print jobs on the three printers. Plans are your own estimates and are not connected to the machines."
      />
      <div className="mb-4">
        <Alert kind="info" title="How planning works with production">
          A plan reserves a time slot so two jobs are never planned on one printer at once. It does not start a job
          or reserve material: starting still follows first in, first out, the material check and printer availability.
          If a job starts without a chosen printer, its planned printer is used when it is free.
        </Alert>
      </div>

      {error && <div className="mb-4"><Alert kind="error" onRetry={reload}>{error}</Alert></div>}
      {loading && !data && <LoadingBlock />}

      {data && (
        <div className="space-y-6">
          {data.alerts.length > 0 && (
            <Alert kind="warning" title={`${data.alerts.length} delayed ${data.alerts.length === 1 ? "job" : "jobs"}`}>
              <ul className="list-disc space-y-0.5 pl-5">{data.alerts.map((a) => <li key={a}>{a}</li>)}</ul>
            </Alert>
          )}

          <section aria-label="Printer availability" className="grid gap-3 sm:grid-cols-3">
            {data.printers.map((p) => (
              <div key={p.id} className="rounded-panel border border-slate-200 bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">{p.name}</h2>
                  <MachineBadge status={p.status} />
                </div>
                <p className="mt-1 text-xs text-slate-700">
                  {p.current_order_number ? `Running ${p.current_order_number}` : "No job running"}
                </p>
                <p className="text-xs text-slate-700">
                  {p.next_planned_order_number && p.next_planned_start_at
                    ? `Next planned: ${p.next_planned_order_number}, ${formatPlanTime(p.next_planned_start_at)}`
                    : "Nothing planned in this window"}
                </p>
              </div>
            ))}
          </section>

          <Card
            title="Timeline"
            description={`${formatPlanTime(data.window_start)} to ${formatPlanTime(data.window_end)} (${data.timezone})`}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-32">
                  <Select ariaLabel="Days to show" value={days} onChange={(v) => { setDays(v); setStart(null); }}
                    options={[{ value: "1", label: "1 day" }, { value: "3", label: "3 days" }, { value: "7", label: "7 days" }]} />
                </div>
                <Button variant="secondary" onClick={() => shift(-1)}><span aria-hidden="true">←</span> Earlier</Button>
                <Button variant="secondary" onClick={() => setStart(null)}>Now</Button>
                <Button variant="secondary" onClick={() => shift(1)}>Later <span aria-hidden="true">→</span></Button>
              </div>
            }
          >
            <div className="max-md:hidden"><ScheduleTimeline schedule={data} /></div>
            <p className="md:hidden text-sm text-slate-700">The timeline needs a wider screen. The planned jobs are listed below.</p>
          </Card>

          <Card title={`Planned jobs (${jobs.length})`} description="The same information as the timeline, in text" flush>
            {jobs.length === 0 ? (
              <EmptyState title="Nothing is planned in this time window" description="Plan an order from the list below, or move the window." />
            ) : (
              <div aria-busy={refreshing} className={refreshing ? "opacity-60" : ""}>
                <Table label="Planned jobs">
                  <Thead>
                    <Tr><Th>Printer</Th><Th>Order</Th><Th>Product</Th><Th>Planned</Th><Th>Minutes</Th><Th>State</Th><Th>Actual</Th><Th><span className="sr-only">Actions</span></Th></Tr>
                  </Thead>
                  <Tbody>
                    {jobs.map((job) => (
                      <Tr key={job.order_id}>
                        <Td label="Printer">{job.printer}</Td>
                        <Td label="Order"><Link href={`/orders/${job.order_id}`} className="font-semibold text-brand-strong hover:underline">{job.order_number}</Link></Td>
                        <Td label="Product" className="break-words">{job.product} × {job.quantity}</Td>
                        <Td label="Planned" className="md:whitespace-nowrap">
                          {formatPlanTime(job.planned_start_at)}<span className="block text-xs text-slate-600">to {formatPlanTime(job.planned_end_at)}</span>
                        </Td>
                        <Td label="Minutes" className="tabular-nums">{job.estimated_duration_minutes}</Td>
                        <Td label="State">
                          <Badge tone={tone[job.state]}>{label[job.state]}</Badge>
                          {job.material_short_now && <span className="mt-1 block text-xs text-amber-900">Material short now</span>}
                        </Td>
                        <Td label="Actual" className="text-xs text-slate-700 md:whitespace-nowrap">
                          {job.actual_start_at ? <>Started {formatPlanTime(job.actual_start_at)}{job.actual_end_at && <span className="block">Done {formatPlanTime(job.actual_end_at)}</span>}</> : "Not started"}
                        </Td>
                        <Td className="max-md:justify-end">
                          {canManage && job.can_change && (
                            <div className="flex flex-wrap gap-2 max-md:justify-end">
                              <Button variant="secondary" aria-label={`Reschedule ${job.order_number}`}
                                onClick={() => setPlanning({ id: job.order_id, order_number: job.order_number, product: job.product,
                                  current: { machine_id: job.machine_id, planned_start_at: job.planned_start_at, estimated_duration_minutes: job.estimated_duration_minutes } })}>
                                Reschedule
                              </Button>
                              <Button variant="secondary" aria-label={`Remove plan of ${job.order_number}`}
                                onClick={() => { setRemoveError(null); setRemoving({ id: job.order_id, order_number: job.order_number }); }}>
                                Remove plan
                              </Button>
                            </div>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </div>
            )}
          </Card>

          <Card title={`Orders without a plan (${data.unscheduled_total})`}
            description="The oldest orders that have not started printing. Planning is optional. To plan any other order, open it and choose Plan print." flush>
            {data.unscheduled.length === 0 ? (
              <EmptyState title="Every order that can be planned has a plan" />
            ) : (
              <Table label="Orders without a plan">
                <Thead><Tr><Th>Order</Th><Th>Product</Th><Th>Qty</Th><Th>Now at</Th><Th><span className="sr-only">Actions</span></Th></Tr></Thead>
                <Tbody>
                  {data.unscheduled.map((o) => (
                    <Tr key={o.id}>
                      <Td label="Order"><Link href={`/orders/${o.id}`} className="font-semibold text-brand-strong hover:underline">{o.order_number}</Link></Td>
                      <Td label="Product" className="break-words">{o.product}</Td>
                      <Td label="Qty" className="tabular-nums">{o.quantity}</Td>
                      <Td label="Now at">{STEP_LABELS[o.current_step]}</Td>
                      <Td className="max-md:[&>button]:w-full">
                        {canManage && (
                          <Button aria-label={`Plan ${o.order_number}`} onClick={() => setPlanning({ id: o.id, order_number: o.order_number, product: o.product })}>
                            Plan
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {planning && data && (
        <ScheduleDialog target={planning} printers={data.printers} onClose={() => setPlanning(null)}
          onSaved={() => { toast("success", `Plan saved for ${planning.order_number}`); setPlanning(null); reload(); }} />
      )}
      {removing && (
        <ConfirmDialog title={`Remove the plan of ${removing.order_number}?`}
          message={<>The order stays where it is in production. Only the planned time is removed.
            {removeError && <div className="mt-3"><Alert kind="error">{removeError}</Alert></div>}</>}
          confirmLabel="Remove plan" danger onConfirm={removePlan} onCancel={() => setRemoving(null)} />
      )}
    </>
  );
}
