"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, ResultBadge, StatusBadge, StepStateBadge } from "@/components/Badge";
import { OrderForm } from "@/components/OrderForm";
import { ScheduleDialog } from "@/components/ScheduleDialog";
import { useToast } from "@/components/Toast";
import {
  Alert, Button, Card, EmptyState, LinkButton, LoadingBlock, PageHeader, Table, Tbody, Td, TextLink,
  Th, Thead, Tr,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatPlanTime, formatQty, STEP_LABELS, STEP_ORDER } from "@/lib/format";
import { useLiveData } from "@/lib/hooks";
import type { Machine, OrderDetail, Paged, ResourceUsage, ScheduleState } from "@/lib/types";

function Detail({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-900">{children}</dd>
    </div>
  );
}

const planTone = { planned: "slate", running: "blue", delayed: "amber", completed: "green" } as const;
const planLabel: Record<ScheduleState, string> = { planned: "Planned", running: "Running", delayed: "Delayed", completed: "Completed" };
function PlanBadge({ state }: { state: ScheduleState }) {
  return <Badge tone={planTone[state]}>{planLabel[state]}</Badge>;
}

function Stepper({ order }: { order: OrderDetail }) {
  const currentIndex = STEP_ORDER.indexOf(order.current_step);
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Production progress">
      {STEP_ORDER.map((step, index) => {
        const record = order.production_records.find((r) => r.step === step);
        const done = record?.status === "completed";
        const running = record?.status === "in_progress";
        const current = index === currentIndex && order.status !== "released";
        // Text and symbol say the state; color only supports it
        const state = done ? "✓ Done" : running ? "● Running" : current ? "→ Up next" : "○ Not started";
        const tone = done
          ? "border-emerald-300 bg-emerald-50"
          : running ? "border-blue-300 bg-blue-50"
          : current ? "border-brand-ring bg-brand-tint" : "border-slate-200 bg-canvas";
        return (
          <li key={step} className={`rounded-control border px-3 py-2.5 ${tone}`} aria-current={current ? "step" : undefined}>
            <p className="text-xs text-slate-600">Step {index + 1}</p>
            <p className="text-sm font-semibold text-slate-900">{STEP_LABELS[step]}</p>
            <p className="mt-0.5 text-xs font-medium text-slate-700">
              {state}{record?.machine_name ? ` · ${record.machine_name}` : ""}
            </p>
            {record?.completed_at && <p className="text-xs text-slate-600">{formatDateTime(record.completed_at)}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function MaterialsTable({ order, usage }: { order: OrderDetail; usage: ResourceUsage[] }) {
  return (
    <Table label="Materials for this order">
      <Thead>
        <Tr>
          <Th>Material</Th><Th className="md:text-right">Required</Th><Th className="md:text-right">Reserved</Th>
          <Th className="md:text-right">Actually used</Th><Th>Status</Th>
        </Tr>
      </Thead>
      <Tbody>
        {order.material_requirements.map((need) => {
          const row = usage.find((u) => u.resource_name === need.name);
          const unused = row?.actual_quantity != null ? row.reserved_quantity - row.actual_quantity : 0;
          return (
            <Tr key={need.name}>
              <Td label="Material" className="break-words font-medium text-slate-900">{need.name}</Td>
              <Td label="Required" className="tabular-nums md:text-right">{formatQty(need.quantity, need.unit)}</Td>
              <Td label="Reserved" className="tabular-nums md:text-right">{row ? formatQty(row.reserved_quantity, row.unit) : "—"}</Td>
              <Td label="Actually used" className="tabular-nums md:text-right">
                {row?.actual_quantity != null ? (
                  <>
                    {formatQty(row.actual_quantity, row.unit)}
                    {unused > 0 && <span className="block text-xs text-slate-600">{formatQty(unused, row.unit)} unused, returned to stock</span>}
                  </>
                ) : "—"}
              </Td>
              <Td label="Status">
                {!row ? <Badge tone="slate">Not reserved</Badge>
                  : row.status === "consumed" ? <Badge tone="green">Consumed</Badge>
                  : <Badge tone="amber">Reserved</Badge>}
              </Td>
            </Tr>
          );
        })}
      </Tbody>
    </Table>
  );
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [planning, setPlanning] = useState(false);
  const { can } = useAuth();
  const { data: order, error, loading, reload } = useLiveData(() => api<OrderDetail>(`/api/orders/${id}`), [id]);
  const { data: machines } = useLiveData(() => api<Machine[]>("/api/machines"));
  const { data: usage } = useLiveData(() => api<Paged<ResourceUsage>>(`/api/resources/usage?order_id=${id}&page_size=100`), [id]);

  if (loading && !order) return <LoadingBlock />;
  if (!order) {
    return (
      <>
        <PageHeader title="Order" backHref="/orders" backLabel="Orders" />
        <Alert kind="error" onRetry={reload}>{error ?? "Order not found"}</Alert>
      </>
    );
  }

  const atQuality = order.current_step === "quality_inspection" && order.status !== "released";
  const releasable = order.release_blockers.length === 0 && order.status !== "released";

  return (
    <>
      <PageHeader
        title={order.order_number}
        description={order.product}
        backHref="/orders"
        backLabel="Orders"
        actions={
          <>
            <StatusBadge status={order.status} />
            {order.can_edit && !editing && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
            {order.can_plan && can("schedule:manage") && (
              <Button variant="secondary" onClick={() => setPlanning(true)}>
                {order.planned_start_at ? "Reschedule print" : "Plan print"}
              </Button>
            )}
            <LinkButton href="/production">Production board</LinkButton>
          </>
        }
      />

      {planning && (
        <ScheduleDialog
          target={{
            id: order.id, order_number: order.order_number, product: order.product,
            current: order.planned_start_at && order.planned_machine_id && order.estimated_duration_minutes
              ? { machine_id: order.planned_machine_id, planned_start_at: order.planned_start_at, estimated_duration_minutes: order.estimated_duration_minutes }
              : undefined,
          }}
          printers={(machines ?? []).map((m) => ({ ...m, next_planned_order_number: null, next_planned_start_at: null, jobs: [] }))}
          onClose={() => setPlanning(false)}
          onSaved={() => { setPlanning(false); toast("success", "Plan saved"); reload(); }}
        />
      )}

      {order.status === "released" && (
        <div className="mb-4"><Alert kind="success" title="Released">This order is released and is now read-only.</Alert></div>
      )}
      {error && <div className="mb-4"><Alert kind="error" onRetry={reload}>{error}</Alert></div>}

      <div className="space-y-6">
        <Card title={editing ? "Edit order" : "Order details"}>
          {editing ? (
            <OrderForm
              order={order}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                toast("success", "Order updated");
                reload();
              }}
            />
          ) : (
            <>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Detail label="Order number">{order.order_number}</Detail>
                <Detail label="Product">{order.product}</Detail>
                <Detail label="Quantity">{order.quantity}</Detail>
                <Detail label="Design reference"><span className="break-all font-mono text-xs">{order.design_reference}</span></Detail>
                <Detail label="Current step">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {order.status === "released" ? "Complete" : STEP_LABELS[order.current_step]}
                    <StepStateBadge order={order} />
                  </span>
                </Detail>
                <Detail label="Created">{formatDateTime(order.created_at)}</Detail>
                <Detail label="Planned print time" className="sm:col-span-2">
                  {order.planned_start_at && order.planned_end_at ? (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {machines?.find((m) => m.id === order.planned_machine_id)?.name ?? "Printer"}:{" "}
                      {formatPlanTime(order.planned_start_at)} to {formatPlanTime(order.planned_end_at)} ({order.estimated_duration_minutes} min)
                      {order.schedule_state && <PlanBadge state={order.schedule_state} />}
                      <TextLink href="/schedule" className="text-xs">Open schedule</TextLink>
                    </span>
                  ) : (
                    <span className="text-slate-700">Not planned. <TextLink href="/schedule">Plan it on the schedule</TextLink></span>
                  )}
                </Detail>
                <Detail label="Notes" className="sm:col-span-2">{order.notes || "—"}</Detail>
              </dl>
              {!order.can_edit_production_fields && order.status !== "released" && (
                <p className="mt-4 text-xs text-slate-600">
                  Production has started: product, quantity and design reference are locked. Notes can still be edited.
                </p>
              )}
            </>
          )}
        </Card>

        <Card title="Production progress"><Stepper order={order} /></Card>

        <Card
          title="Materials"
          description="What the order needs, what is reserved for the print job, and what was actually used"
          flush
        >
          <MaterialsTable order={order} usage={usage?.items ?? []} />
        </Card>

        <Card title="Quality and release">
          <div className="mb-4">
            {order.status === "released" ? (
              <Alert kind="success">Released. All steps were complete and the latest inspection passed.</Alert>
            ) : releasable ? (
              <Alert kind="success" title="Eligible for release">
                All steps are complete and the latest inspection passed.{" "}
                <TextLink href="/quality">Release it on the Quality &amp; Release page</TextLink>.
              </Alert>
            ) : (
              <Alert kind={order.status === "qc_failed" ? "error" : "warning"} title="Release is blocked">
                <ul className="list-disc space-y-0.5 pl-5">
                  {order.release_blockers.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
                {atQuality && (
                  <p className="mt-2">
                    Next step: <TextLink href="/quality">record an inspection</TextLink>
                    {order.status === "qc_failed" ? " and pass it" : ""}.
                  </p>
                )}
                {!atQuality && order.status !== "qc_failed" && (
                  <p className="mt-2">Next step: finish production on the <TextLink href="/production">Production Board</TextLink>.</p>
                )}
              </Alert>
            )}
          </div>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Inspection history</h3>
          {order.inspections.length === 0 ? (
            <EmptyState title="No inspections yet" description="An inspection can be recorded once post-processing is complete." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {order.inspections.map((inspection) => (
                <li key={inspection.id} className="py-2.5 text-sm first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <ResultBadge result={inspection.result} />
                    <time className="text-xs text-slate-600" dateTime={inspection.inspected_at}>{formatDateTime(inspection.inspected_at)} · by {inspection.inspected_by}</time>
                  </div>
                  {inspection.notes && <p className="mt-1 break-words text-slate-700">{inspection.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Status history" description="Every step and status change, newest first">
          <ol className="space-y-3">
            {order.history.map((entry) => (
              <li key={entry.id} className="flex gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-ring" aria-hidden="true" />
                <div className="min-w-0 flex-1 sm:flex sm:justify-between sm:gap-3">
                  <p className="break-words text-slate-800">{entry.note}</p>
                  <time className="shrink-0 text-xs text-slate-600" dateTime={entry.created_at}>{formatDateTime(entry.created_at)} · {entry.actor}</time>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
