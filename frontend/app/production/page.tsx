"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, MachineBadge, StatusBadge, StepBadge } from "@/components/Badge";
import { CompletePrintingDialog } from "@/components/CompletePrintingDialog";
import { ConfirmDialog } from "@/components/Dialog";
import { StartPrintingDialog } from "@/components/StartPrintingDialog";
import { useToast } from "@/components/Toast";
import {
  Alert, Button, Card, EmptyState, LinkButton, LoadingBlock, PageHeader, Table, Tbody, Td, Th, Thead, Tr,
} from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { formatPlanTime, formatQty, STEP_LABELS, STEP_ORDER } from "@/lib/format";
import { useLiveData } from "@/lib/hooks";
import type { Board, BoardItem, Machine, Order, StepKey } from "@/lib/types";

interface BoardData { board: Board; machines: Machine[] }

const PAGE_STEP = 25;  // cards added by "Show more"
const MAX_CARDS = 200; // the most the server will list per step

const BOARD_STEPS: StepKey[] = ["design_review", "printing", "post_processing"];

export default function ProductionPage() {
  const toast = useToast();
  // The server decides which orders can start (over the whole queue). The board only asks to LIST
  // the first `limit` orders of each step, so it stays fast with thousands of orders.
  const [limit, setLimit] = useState(PAGE_STEP);
  const { data, error, loading, reload } = useLiveData(async (): Promise<BoardData> => {
    const [board, machines] = await Promise.all([
      api<Board>(`/api/production/board?limit=${limit}`),
      api<Machine[]>("/api/machines"),
    ]);
    return { board, machines };
  }, [limit]);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [completing, setCompleting] = useState<Order | null>(null);
  const [startingPrint, setStartingPrint] = useState<Order | null>(null);
  const [mobileStep, setMobileStep] = useState<StepKey>("design_review"); // phones show one step at a time

  async function startStep(order: Order) {
    setBusyId(order.id);
    try {
      await api(`/api/orders/${order.id}/steps/${order.current_step}/start`, { method: "POST", body: {} });
      toast("success", `${STEP_LABELS[order.current_step]} started for ${order.order_number}`);
    } catch (err) {
      toast("error", errorText(err));
    } finally {
      setBusyId(null);
      reload();
    }
  }

  // Design review and post-processing: a simple confirmation. (Printing has its own dialog.)
  async function completeStep() {
    if (!completing) return;
    setBusyId(completing.id);
    try {
      await api(`/api/orders/${completing.id}/steps/${completing.current_step}/complete`, { method: "POST", body: {} });
      toast("success", `${STEP_LABELS[completing.current_step]} completed for ${completing.order_number}`);
    } catch (err) {
      toast("error", errorText(err));
    } finally {
      setCompleting(null);
      setBusyId(null);
      reload();
    }
  }

  if (loading && !data) return <><PageHeader title="Production Board" /><LoadingBlock /></>;

  const machines = data?.machines ?? [];
  const idleCount = machines.filter((m) => m.status === "idle").length;
  const columns = new Map(data?.board.steps.map((column) => [column.step, column]));
  const itemsAt = (step: StepKey): BoardItem[] => columns.get(step)?.orders ?? [];
  const totalAt = (step: StepKey): number => columns.get(step)?.total ?? 0;
  const releasedTotal = data?.board.released_total ?? 0;
  // Orders that are waiting in a queue (they have a position), for the table at the bottom
  const waitingItems = BOARD_STEPS.flatMap((step) => itemsAt(step).filter((entry) => entry.position !== null));

  function renderCard(entry: BoardItem) {
    const order = entry.order;
    const item = entry.position !== null ? entry : undefined; // only waiting orders can be started
    const busy = busyId === order.id;
    const printer = machines.find((m) => m.current_order_id === order.id);
    const reasonsId = `reasons-${order.id}`;
    const running = order.step_state === "running";

    return (
      <li key={order.id} className="rounded-control border border-slate-200 bg-white p-3 text-sm shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <Link href={`/orders/${order.id}`} className="min-w-0 whitespace-nowrap font-semibold text-brand-strong hover:underline">
            {order.order_number}
          </Link>
          {item && <Badge tone="slate">#{item.position} in queue</Badge>}
        </div>
        <p className="mt-0.5 break-words text-slate-700">{order.product} × {order.quantity}</p>
        {order.planned_start_at && order.schedule_state !== "completed" && (
          <p className="mt-1 text-xs text-slate-700">
            Planned: {machines.find((m) => m.id === order.planned_machine_id)?.name ?? "printer"}, {formatPlanTime(order.planned_start_at)}
            {order.schedule_state === "delayed" && <strong className="text-amber-900"> (delayed)</strong>}
          </p>
        )}

        {/* State: always words + symbol, never color alone */}
        <div className="mt-2.5">
          {running && (
            <Badge tone="blue">Running{printer ? ` on ${printer.name}` : ""}</Badge>
          )}
          {item?.can_start && <Badge tone="green">Ready to start</Badge>}
          {item && !item.can_start && (
            <div id={reasonsId} className="rounded-control border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-950">
              <p className="font-semibold"><span aria-hidden="true">! </span>Blocked, cannot start yet</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {item.blocked_reasons.map((reason) => <li key={reason} className="break-words">{reason}</li>)}
              </ul>
            </div>
          )}
          {order.status === "qc_failed" && <StatusBadge status="qc_failed" />}
          {order.status === "awaiting_qc" && <Badge tone="amber">Waiting for inspection</Badge>}
          {order.status === "ready_for_release" && <Badge tone="violet">Passed QC, ready for release</Badge>}
        </div>

        {item && order.current_step === "printing" && item.material_requirements.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-slate-700" aria-label="Materials needed">
            {item.material_requirements.map((m) => (
              <li key={m.name} className="break-words">
                {m.name}: {formatQty(m.quantity, m.unit)} needed, {formatQty(m.available, m.unit)} available
                {m.available < m.quantity && <strong className="text-red-700"> (short)</strong>}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          {item && (
            <Button
              className="w-full sm:w-auto"
              loading={busy}
              disabled={!item.can_start}
              aria-describedby={!item.can_start ? reasonsId : undefined}
              onClick={() => (order.current_step === "printing" ? setStartingPrint(order) : startStep(order))}
              aria-label={`Start ${STEP_LABELS[order.current_step]} for ${order.order_number}`}
            >
              {order.current_step === "printing" ? "Start…" : "Start"}
            </Button>
          )}
          {running && BOARD_STEPS.includes(order.current_step) && (
            <Button className="w-full sm:w-auto" loading={busy} onClick={() => setCompleting(order)}
              aria-label={`Complete ${STEP_LABELS[order.current_step]} for ${order.order_number}`}>
              Complete
            </Button>
          )}
          {(order.current_step === "quality_inspection" || order.status === "ready_for_release") && (
            <LinkButton href="/quality" className="w-full sm:w-auto">
              {order.status === "ready_for_release" ? "Release" : "Inspect"}
            </LinkButton>
          )}
        </div>
      </li>
    );
  }

  const startingItem = startingPrint ? waitingItems.find((entry) => entry.order.id === startingPrint.id) : undefined;

  return (
    <>
      <PageHeader title="Production Board" description="Move orders through the five production steps. Updates appear live." />
      {error && <div className="mb-4"><Alert kind="error" onRetry={reload}>{error}</Alert></div>}

      <section aria-label="Printers" className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">
          Printers <span className="font-normal text-slate-600">· {idleCount} of {machines.length} available</span>
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {machines.map((machine) => (
            <div key={machine.id} className="rounded-panel border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">{machine.name}</p>
                <MachineBadge status={machine.status} />
              </div>
              <p className="mt-1 break-words text-xs text-slate-600">
                {machine.current_order_id ? (
                  <>Running <Link href={`/orders/${machine.current_order_id}`} className="font-medium text-brand-strong hover:underline">{machine.current_order_number}</Link></>
                ) : "Ready for the next job"}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Phones: choose a step. Larger screens show every step side by side. */}
      <div role="group" aria-label="Show production step" className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 md:hidden">
        {STEP_ORDER.map((step, index) => (
          <button
            key={step}
            onClick={() => setMobileStep(step)}
            aria-pressed={mobileStep === step}
            className={`flex min-h-11 shrink-0 items-center gap-2 rounded-control border px-3 text-sm font-medium ${
              mobileStep === step ? "border-brand-ring bg-brand-tint text-slate-900" : "border-slate-500 bg-white text-slate-700"
            }`}
          >
            {index + 1}. {STEP_LABELS[step]}
            <span className="rounded-full bg-slate-100 px-1.5 text-xs tabular-nums text-slate-700">{totalAt(step)}</span>
          </button>
        ))}
      </div>

      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3 wide:grid-cols-5">
        {STEP_ORDER.map((step, index) => {
          const items = itemsAt(step);
          const total = totalAt(step);
          return (
            <section
              key={step}
              aria-label={STEP_LABELS[step]}
              className={`rounded-panel border border-slate-200 bg-slate-100/70 ${step === mobileStep ? "" : "max-md:hidden"}`}
            >
              <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
                <h2 className="text-sm font-semibold text-slate-900">{index + 1}. {STEP_LABELS[step]}</h2>
                <span className="rounded-full bg-white px-2 text-xs font-medium tabular-nums text-slate-700 ring-1 ring-inset ring-slate-200">
                  {total.toLocaleString()}<span className="sr-only"> {total === 1 ? "order" : "orders"}</span>
                </span>
              </header>
              <ul className="space-y-2 p-2">
                {items.length === 0 && <li className="px-1 py-6 text-center text-xs text-slate-600">No orders at this step</li>}
                {items.map(renderCard)}
                {total > items.length && (
                  <li className="px-1 pt-1 text-center text-xs text-slate-700">
                    <p aria-live="polite">Showing {items.length} of {total.toLocaleString()}</p>
                    {limit < MAX_CARDS ? (
                      <Button variant="secondary" className="mt-2 w-full" onClick={() => setLimit((current) => Math.min(MAX_CARDS, current + PAGE_STEP))}>
                        Show {PAGE_STEP} more
                      </Button>
                    ) : (
                      <Link href={`/orders?step=${step}`} className="mt-1 inline-block font-medium text-brand-strong hover:underline">
                        Open the Orders list to see the rest
                      </Link>
                    )}
                  </li>
                )}
                {step === "final_release" && releasedTotal > 0 && (
                  <li className="px-1 pt-1 text-xs text-slate-600">
                    {releasedTotal.toLocaleString()} released ·{" "}
                    <Link href="/orders?status=released" className="font-medium text-brand-strong hover:underline">view</Link>
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>

      <Card title="Ready queue (first in, first out)" description={`Orders waiting for their next step, oldest first. Blocked orders do not hold up the others. Shows the first ${limit} of each step.`} flush>
        {data && waitingItems.length === 0 ? (
          <EmptyState title="Nothing is waiting" description="Orders appear here when they are ready for their next step." />
        ) : (
          <Table label="Ready queue">
            <Thead>
              <Tr><Th>#</Th><Th>Order</Th><Th>Waiting for</Th><Th>Material needed</Th><Th>Can start?</Th></Tr>
            </Thead>
            <Tbody>
              {waitingItems.map((item) => (
                <Tr key={item.order.id}>
                  <Td label="Position" className="tabular-nums">{item.position}</Td>
                  <Td label="Order"><Link href={`/orders/${item.order.id}`} className="font-semibold text-brand-strong hover:underline">{item.order.order_number}</Link></Td>
                  <Td label="Waiting for"><StepBadge step={item.order.current_step} /></Td>
                  <Td label="Material needed">
                    {item.material_requirements.length === 0 ? "—" : (
                      <ul className="space-y-1">
                        {item.material_requirements.map((m) => (
                          <li key={m.name} className="break-words">
                            {m.quantity.toLocaleString()} {m.unit} {m.name}
                            <span className="block text-xs text-slate-600">
                              {m.available.toLocaleString()} {m.unit} available
                              {m.available < m.quantity && <strong className="text-red-700"> · short by {(m.quantity - m.available).toLocaleString()} {m.unit}</strong>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                  <Td label="Can start?">
                    {item.can_start ? <Badge tone="green">Yes</Badge> : (
                      <div className="max-w-md text-xs text-amber-950">
                        <Badge tone="amber">Blocked</Badge>
                        <p className="mt-1 break-words">{item.blocked_reasons.join("; ")}</p>
                      </div>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {startingPrint && startingItem && (
        <StartPrintingDialog
          order={startingPrint}
          item={startingItem}
          machines={machines}
          onClose={() => setStartingPrint(null)}
          onStarted={() => {
            toast("success", `3D Printing started for ${startingPrint.order_number}`);
            setStartingPrint(null);
            reload();
          }}
        />
      )}

      {completing && completing.current_step === "printing" ? (
        <CompletePrintingDialog
          order={completing}
          onClose={() => setCompleting(null)}
          onCompleted={() => {
            toast("success", `3D Printing completed for ${completing.order_number}`);
            setCompleting(null);
            reload();
          }}
        />
      ) : completing ? (
        <ConfirmDialog
          title={`Complete ${STEP_LABELS[completing.current_step]}?`}
          message={`${completing.order_number} will move on to the next step.`}
          confirmLabel="Complete step"
          busy={busyId === completing.id}
          onConfirm={completeStep}
          onCancel={() => setCompleting(null)}
        />
      ) : null}
    </>
  );
}
