"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { StatusBadge, StepBadge, StepStateBadge } from "@/components/Badge";
import { Pagination } from "@/components/Pagination";
import { Select } from "@/components/Select";
import {
  Alert, Button, Card, EmptyState, LinkButton, LoadingBlock, PageHeader, SearchInput,
  Table, Tbody, Td, Th, Thead, Tr,
} from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, STATUS_LABELS, STEP_LABELS, STEP_ORDER } from "@/lib/format";
import { useDebounced, useLiveData, usePagination } from "@/lib/hooks";
import type { Order, Paged } from "@/lib/types";

const statusOptions = [
  { value: "all", label: "All statuses" },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];
const stepOptions = [
  { value: "all", label: "All steps" },
  ...STEP_ORDER.map((key) => ({ value: key, label: STEP_LABELS[key] })),
];

function OrdersContent() {
  // Links such as /orders?status=in_production (from the dashboard) start with that filter applied
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "all");
  const [step, setStep] = useState(params.get("step") ?? "all");

  // The box shows what is typed right away. Only the value that stopped changing is searched.
  const committedSearch = useDebounced(search.trim(), 300);
  const { page, pageSize, setPage, setPageSize } = usePagination(25, `${committedSearch}|${status}|${step}`);

  const { data, error, loading, refreshing, reload } = useLiveData(() => {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (committedSearch) query.set("search", committedSearch);
    if (status !== "all") query.set("status", status);
    if (step !== "all") query.set("step", step);
    return api<Paged<Order>>(`/api/orders?${query}`);
  }, [committedSearch, status, step, page, pageSize]);

  const orders = data?.items;
  const filtered = search !== "" || status !== "all" || step !== "all";
  const searching = search.trim() !== committedSearch; // typed, but not searched yet
  function clearFilters() {
    setSearch("");
    setStatus("all");
    setStep("all");
  }

  return (
    <>
      <PageHeader
        title="Orders"
        description="Search, filter and open any manufacturing order"
        actions={<LinkButton href="/orders/new" variant="primary">New order</LinkButton>}
      />

      <Card flush>
        <div className="flex flex-col gap-2 border-b border-slate-200 p-3 sm:p-4 md:flex-row md:items-center">
          <SearchInput
            aria-label="Search orders"
            placeholder="Order, product or design ref"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="md:flex-1"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:flex md:w-auto">
            <Select ariaLabel="Filter by status" value={status} onChange={setStatus} options={statusOptions} className="md:w-48" />
            <Select ariaLabel="Filter by step" value={step} onChange={setStep} options={stepOptions} className="md:w-48" />
          </div>
          {filtered && <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
        </div>

        {error && <div className="p-4"><Alert kind="error" title="Orders could not be loaded" onRetry={reload}>{error}</Alert></div>}
        {loading && !orders && <LoadingBlock />}
        {orders && orders.length === 0 && (
          <EmptyState
            title={filtered ? "No orders match your filters" : "No orders yet"}
            description={filtered ? "Try a different search, or clear the filters to see every order." : "Create the first order to get started."}
            action={filtered
              ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>
              : <LinkButton href="/orders/new" variant="primary">New order</LinkButton>}
          />
        )}
        {orders && orders.length > 0 && (
          <div aria-busy={refreshing || searching} className={refreshing || searching ? "opacity-60 transition-opacity" : ""}>
            <Table label="Orders">
              <Thead>
                <Tr>
                  <Th>Order</Th><Th>Product</Th><Th>Qty</Th><Th>Design ref</Th>
                  <Th>Current step</Th><Th>Status</Th><Th>Created</Th>
                </Tr>
              </Thead>
              <Tbody>
                {orders.map((order) => (
                  <Tr key={order.id}>
                    <Td label="Order">
                      <Link href={`/orders/${order.id}`} className="font-semibold text-brand-strong hover:underline">
                        {order.order_number}
                      </Link>
                    </Td>
                    <Td label="Product" className="break-words md:min-w-40 md:max-w-64">{order.product}</Td>
                    <Td label="Qty" className="tabular-nums">{order.quantity}</Td>
                    <Td label="Design ref" className="break-all font-mono text-xs md:max-w-48">{order.design_reference}</Td>
                    <Td label="Current step">
                      <div className="flex flex-wrap items-center gap-1.5 max-md:justify-end">
                        <StepBadge step={order.current_step} />
                        <StepStateBadge order={order} />
                      </div>
                    </Td>
                    <Td label="Status"><StatusBadge status={order.status} /></Td>
                    <Td label="Created" className="whitespace-nowrap text-slate-600">{formatDateTime(order.created_at)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        )}
        {data && (
          <Pagination
            page={data.page} pageSize={data.page_size} total={data.total} totalPages={data.total_pages}
            itemName={{ one: "order", many: "orders" }}
            onPageChange={setPage} onPageSizeChange={setPageSize}
          />
        )}
      </Card>
    </>
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <OrdersContent />
    </Suspense>
  );
}
