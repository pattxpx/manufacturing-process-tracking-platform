"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/Badge";
import { Pagination } from "@/components/Pagination";
import { AdjustStockDialog, ResourceFormDialog, StockHistoryDialog } from "@/components/ResourceDialogs";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { Select } from "@/components/Select";
import {
  Alert, Button, Card, EmptyState, LoadingBlock, PageHeader, StockBar, Table, Tbody, Td, Th, Thead, Tr,
} from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, formatQty } from "@/lib/format";
import { useLiveData, usePagination } from "@/lib/hooks";
import type { Paged, Resource, ResourceUsage } from "@/lib/types";

type Dialogs =
  | { kind: "create" } | { kind: "edit"; resource: Resource }
  | { kind: "adjust"; resource: Resource } | { kind: "history"; resource: Resource };

export default function ResourcesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [resourceId, setResourceId] = useState("all");
  const { page, pageSize, setPage, setPageSize } = usePagination(25, resourceId);
  const resources = useLiveData(() => api<Resource[]>("/api/resources"));
  const usage = useLiveData(() => {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (resourceId !== "all") query.set("resource_id", resourceId);
    return api<Paged<ResourceUsage>>(`/api/resources/usage?${query}`);
  }, [resourceId, page, pageSize]);

  const balances = resources.data ?? [];
  const materialOptions = [
    { value: "all", label: "All materials" },
    ...balances.map((r) => ({ value: String(r.id), label: r.name })),
  ];

  return (
    <>
      <PageHeader
        title="Resources"
        description="Material stock, reservations and usage by order"
        actions={can("resources:manage") ? <Button onClick={() => setDialog({ kind: "create" })}>Add material</Button> : undefined}
      />
      {resources.error && <div className="mb-4"><Alert kind="error" onRetry={resources.reload}>{resources.error}</Alert></div>}
      {resources.loading && !resources.data && <LoadingBlock />}

      {resources.data && (
        <Card
          title="Stock"
          description="Available = on hand minus reserved. Reserved material is held for jobs that are printing."
          className="mb-6"
          flush
        >
          <Table label="Material stock">
            <Thead>
              <Tr>
                <Th>Material</Th><Th className="md:text-right">On hand</Th>
                <Th className="md:text-right">Reserved</Th><Th className="md:text-right">Available</Th><Th>Status</Th>
                <Th><span className="sr-only">Actions</span></Th>
              </Tr>
            </Thead>
            <Tbody>
              {balances.map((r) => {
                return (
                  <Tr key={r.id}>
                    <Td label="Material" className="break-words font-medium text-slate-900">
                      {r.name}
                      {!r.is_active && <> <Badge tone="slate">Inactive</Badge></>}
                      <span className="block text-xs font-normal text-slate-600">
                        {r.category} · measured in {r.unit}{r.min_stock > 0 && ` · minimum ${formatQty(r.min_stock, r.unit)}`}
                      </span>
                    </Td>
                    <Td label="On hand" className="whitespace-nowrap tabular-nums md:text-right">{formatQty(r.on_hand, r.unit)}</Td>
                    <Td label="Reserved" className="whitespace-nowrap tabular-nums md:text-right">{formatQty(r.reserved, r.unit)}</Td>
                    <Td label="Available" className="md:min-w-36 md:text-right">
                      <span className="font-semibold tabular-nums text-slate-900">{formatQty(r.available, r.unit)}</span>
                      <div className="mt-1.5 max-md:hidden"><StockBar reserved={r.reserved} onHand={r.on_hand} /></div>
                    </Td>
                    <Td label="Status">
                      {r.low_stock && r.available > 0 && <div className="mb-1"><Badge tone="amber">Low stock</Badge></div>}
                      {r.available === 0 ? <Badge tone="red">Out of stock</Badge>
                        : r.waiting_short_total > 0 ? (
                          <div>
                            <Badge tone="amber">Short for {r.waiting_short_total} waiting {r.waiting_short_total === 1 ? "order" : "orders"}</Badge>
                            <p className="mt-1 break-words text-xs text-slate-700">
                              {r.waiting_short_orders.map((o, i) => (
                                <span key={o.id}>
                                  {i > 0 && ", "}
                                  <Link href={`/orders/${o.id}`} className="font-medium text-brand-strong hover:underline">{o.order_number}</Link>
                                </span>
                              ))}
                              {r.waiting_short_total > r.waiting_short_orders.length && ` and ${r.waiting_short_total - r.waiting_short_orders.length} more`}
                            </p>
                          </div>
                        ) : <Badge tone="green">Enough in stock</Badge>}
                    </Td>
                    <Td className="max-md:justify-end">
                      <div className="flex flex-wrap gap-2 max-md:justify-end">
                        {can("resources:manage") && <Button variant="secondary" onClick={() => setDialog({ kind: "edit", resource: r })} aria-label={`Edit ${r.name}`}>Edit</Button>}
                        {can("stock:adjust") && <Button variant="secondary" onClick={() => setDialog({ kind: "adjust", resource: r })} aria-label={`Adjust stock of ${r.name}`}>Adjust stock</Button>}
                        <Button variant="secondary" onClick={() => setDialog({ kind: "history", resource: r })} aria-label={`Stock history of ${r.name}`}>History</Button>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </Card>
      )}

      <Card
        title="Usage history"
        description="One row per material for each print job: what was reserved and what was actually used"
        action={
          <div className="w-full sm:w-56">
            <Select ariaLabel="Filter by material" value={resourceId} onChange={setResourceId} options={materialOptions} />
          </div>
        }
        flush
      >
        {usage.error && <div className="p-4"><Alert kind="error" onRetry={usage.reload}>{usage.error}</Alert></div>}
        {usage.loading && !usage.data && <LoadingBlock />}
        {usage.data && usage.data.items.length === 0 && (
          <EmptyState
            title={resourceId !== "all" ? "No usage for this material yet" : "No material usage yet"}
            description="Usage is recorded when an order starts printing."
          />
        )}
        {usage.data && usage.data.items.length > 0 && (
          <div aria-busy={usage.refreshing} className={usage.refreshing ? "opacity-60 transition-opacity" : ""}>
          <Table label="Material usage history">
            <Thead>
              <Tr>
                <Th>Order</Th><Th>Material</Th><Th className="md:text-right">Reserved</Th>
                <Th className="md:text-right">Actual used</Th><Th>Status</Th><Th>When</Th>
              </Tr>
            </Thead>
            <Tbody>
              {usage.data.items.map((u) => {
                const unused = u.actual_quantity != null ? u.reserved_quantity - u.actual_quantity : 0;
                return (
                  <Tr key={u.id}>
                    <Td label="Order"><Link href={`/orders/${u.order_id}`} className="font-semibold text-brand-strong hover:underline">{u.order_number}</Link></Td>
                    <Td label="Material" className="break-words">{u.resource_name}</Td>
                    <Td label="Reserved" className="whitespace-nowrap tabular-nums md:text-right">{formatQty(u.reserved_quantity, u.unit)}</Td>
                    <Td label="Actual used" className="tabular-nums md:whitespace-nowrap md:text-right">
                      {u.actual_quantity === null ? "—" : formatQty(u.actual_quantity, u.unit)}
                      {unused > 0 && <span className="block text-xs text-slate-600">{formatQty(unused, u.unit)} unused</span>}
                    </Td>
                    <Td label="Status">{u.status === "consumed" ? <Badge tone="green">Consumed</Badge> : <Badge tone="amber">Reserved</Badge>}</Td>
                    <Td label="When" className="whitespace-nowrap text-xs text-slate-600">
                      <span className="block">Reserved {formatDateTime(u.created_at)}</span>
                      {u.consumed_at && <span className="block">Consumed {formatDateTime(u.consumed_at)}</span>}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
          </div>
        )}
        {usage.data && (
          <Pagination
            page={usage.data.page} pageSize={usage.data.page_size} total={usage.data.total} totalPages={usage.data.total_pages}
            itemName={{ one: "usage record", many: "usage records" }}
            onPageChange={setPage} onPageSizeChange={setPageSize}
          />
        )}
      </Card>

      {dialog?.kind === "create" && (
        <ResourceFormDialog onClose={() => setDialog(null)}
          onSaved={(name) => { toast("success", `Material ${name} added`); setDialog(null); resources.reload(); }} />
      )}
      {dialog?.kind === "edit" && (
        <ResourceFormDialog resource={dialog.resource} onClose={() => setDialog(null)}
          onSaved={(name) => { toast("success", `${name} updated`); setDialog(null); resources.reload(); }} />
      )}
      {dialog?.kind === "adjust" && (
        <AdjustStockDialog resource={dialog.resource} onClose={() => setDialog(null)}
          onSaved={(message) => { toast("success", message); setDialog(null); resources.reload(); usage.reload(); }} />
      )}
      {dialog?.kind === "history" && <StockHistoryDialog resource={dialog.resource} onClose={() => setDialog(null)} />}
    </>
  );
}
