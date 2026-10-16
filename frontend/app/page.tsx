"use client";

import Link from "next/link";
import { Badge, MachineBadge } from "@/components/Badge";
import { Alert, Card, EmptyState, LoadingBlock, PageHeader, StockBar, TextLink } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, formatQty } from "@/lib/format";
import { useLiveData } from "@/lib/hooks";
import type { DashboardSummary } from "@/lib/types";

function StatCard({ label, value, caption, href, tone = "text-slate-900" }: {
  label: string; value: number; caption: string; href: string; tone?: string;
}) {
  return (
    <Link href={href} className="block rounded-panel border border-slate-200 bg-surface p-4 hover:border-brand hover:bg-brand-tint/40">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</p>
      <p className={`mt-1 text-3xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-600">{caption}</p>
    </Link>
  );
}

export default function DashboardPage() {
  const { data, error, loading, reload } = useLiveData(() => api<DashboardSummary>("/api/dashboard"));

  return (
    <>
      <PageHeader title="Dashboard" description="Live overview of orders, printers and materials" />
      {error && <div className="mb-4"><Alert kind="error" onRetry={reload}>{error}</Alert></div>}
      {loading && !data && <LoadingBlock />}
      {data && (
        <div className="space-y-6">
          <section aria-label="Order totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <StatCard label="Total orders" value={data.total_orders} caption="All orders" href="/orders" />
            <StatCard label="In production" value={data.in_production} caption="Being made now" href="/orders?status=in_production" tone="text-blue-800" />
            <StatCard label="Awaiting QC" value={data.awaiting_qc} caption="Ready to inspect" href="/quality" tone="text-amber-800" />
            <StatCard label="QC failed" value={data.qc_failed} caption={data.qc_failed > 0 ? "Needs re-inspection" : "None"} href="/orders?status=qc_failed" tone={data.qc_failed > 0 ? "text-red-700" : "text-slate-900"} />
            <StatCard label="Released" value={data.released} caption="Shipped orders" href="/orders?status=released" tone="text-emerald-800" />
          </section>

          <Card title="Production status by step" description="Orders at each step right now, and how many have finished it">
            <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {data.steps.map((step, index) => (
                <li key={step.step} className="rounded-control border border-slate-200 bg-canvas p-3">
                  <p className="text-xs font-medium text-slate-600">Step {index + 1}</p>
                  <p className="text-sm font-semibold text-slate-900">{step.label}</p>
                  <dl className="mt-2 grid grid-cols-3 gap-1 text-center">
                    <div><dt className="text-xs text-slate-600">Waiting</dt><dd className="text-lg font-semibold tabular-nums text-slate-900">{step.waiting}</dd></div>
                    <div><dt className="text-xs text-slate-600">Running</dt><dd className="text-lg font-semibold tabular-nums text-blue-800">{step.running}</dd></div>
                    <div><dt className="text-xs text-slate-600">Done</dt><dd className="text-lg font-semibold tabular-nums text-emerald-800">{step.completed}</dd></div>
                  </dl>
                </li>
              ))}
            </ol>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card
              title="Printers"
              description={`${data.machines.filter((m) => m.status === "idle").length} of ${data.machines.length} available`}
              action={<TextLink href="/production" className="text-sm">Open board</TextLink>}
            >
              <ul className="divide-y divide-slate-100">
                {data.machines.map((machine) => (
                  <li key={machine.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{machine.name}</p>
                      <p className="break-words text-xs text-slate-600">
                        {machine.current_order_id ? (
                          <>Printing <TextLink href={`/orders/${machine.current_order_id}`}>{machine.current_order_number}</TextLink></>
                        ) : "No active job"}
                      </p>
                    </div>
                    <MachineBadge status={machine.status} />
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Materials" description="Available = on hand minus reserved" action={<TextLink href="/resources" className="text-sm">Details</TextLink>}>
              <ul className="space-y-4">
                {data.resources.map((resource) => (
                  <li key={resource.id} className="text-sm">
                    <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="min-w-0 break-words font-medium text-slate-900">{resource.name}</span>
                      <span className="flex items-center gap-2 text-slate-900">
                        {resource.available === 0 && <Badge tone="red">Out of stock</Badge>}
                        <strong className="tabular-nums">{formatQty(resource.available, resource.unit)}</strong>
                        <span className="text-xs text-slate-600">available</span>
                      </span>
                    </div>
                    <StockBar reserved={resource.reserved} onHand={resource.on_hand} />
                    <p className="mt-1 text-xs text-slate-600">
                      {formatQty(resource.on_hand, resource.unit)} on hand · {formatQty(resource.reserved, resource.unit)} reserved
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card title="Recent activity">
            {data.recent_activity.length === 0 ? (
              <EmptyState title="No activity yet" description="Activity appears here as orders are created and move through production." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.recent_activity.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-0.5 py-2.5 text-sm first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                    <p className="min-w-0 break-words text-slate-800">
                      <TextLink href={`/orders/${entry.order_id}`}>{entry.order_number}</TextLink>{" "}
                      {entry.note}
                    </p>
                    <time className="shrink-0 text-xs text-slate-600" dateTime={entry.created_at}>
                      {formatDateTime(entry.created_at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
