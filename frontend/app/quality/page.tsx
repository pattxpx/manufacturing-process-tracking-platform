"use client";

import Link from "next/link";
import { useState } from "react";
import { ResultBadge, StatusBadge } from "@/components/Badge";
import { ConfirmDialog, Dialog } from "@/components/Dialog";
import { Pagination } from "@/components/Pagination";
import { useToast } from "@/components/Toast";
import {
  Alert, Button, Card, EmptyState, LoadingBlock, PageHeader, Table, Tbody, Td, TextAreaField, Th, Thead, Tr,
} from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useLiveData, usePagination } from "@/lib/hooks";
import type { Inspection, Order, Paged } from "@/lib/types";

const PAGE_SIZE = 10; // three lists share this page, so they start shorter than the Orders list

function ReleaseCheck({ order }: { order: Order }) {
  if (order.release_blockers.length === 0) {
    return <p className="text-xs font-medium text-emerald-800"><span aria-hidden="true">✓ </span>Eligible: all steps complete, latest inspection passed</p>;
  }
  return (
    <div className="text-xs text-amber-950">
      <p className="font-semibold"><span aria-hidden="true">! </span>Release blocked</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
        {order.release_blockers.map((reason) => <li key={reason} className="break-words">{reason}</li>)}
      </ul>
    </div>
  );
}

export default function QualityPage() {
  const toast = useToast();
  // Three lists, each paged by the server on its own
  const pendingPaging = usePagination(PAGE_SIZE);
  const readyPaging = usePagination(PAGE_SIZE);
  const historyPaging = usePagination(PAGE_SIZE);
  const pending = useLiveData(
    () => api<Paged<Order>>(`/api/inspections/pending?page=${pendingPaging.page}&page_size=${pendingPaging.pageSize}`),
    [pendingPaging.page, pendingPaging.pageSize],
  );
  const ready = useLiveData(
    () => api<Paged<Order>>(`/api/orders?status=ready_for_release&page=${readyPaging.page}&page_size=${readyPaging.pageSize}`),
    [readyPaging.page, readyPaging.pageSize],
  );
  const history = useLiveData(
    () => api<Paged<Inspection>>(`/api/inspections?page=${historyPaging.page}&page_size=${historyPaging.pageSize}`),
    [historyPaging.page, historyPaging.pageSize],
  );
  const error = pending.error ?? ready.error ?? history.error;
  const reload = () => { pending.reload(); ready.reload(); history.reload(); };

  const [inspecting, setInspecting] = useState<Order | null>(null);
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [notes, setNotes] = useState("");
  const [notesError, setNotesError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<Order | null>(null);
  const [saving, setSaving] = useState(false);

  function openInspection(order: Order) {
    setInspecting(order);
    setResult("pass");
    setNotes("");
    setNotesError(undefined);
    setFormError(null);
  }

  async function saveInspection() {
    if (!inspecting || saving) return;
    setFormError(null);
    if (result === "fail" && !notes.trim()) {
      setNotesError("Notes are required when an inspection fails");
      // Send keyboard and screen reader focus to the field that needs attention
      setTimeout(() => document.querySelector<HTMLElement>('[role="dialog"] textarea')?.focus(), 0);
      return;
    }
    setNotesError(undefined);
    setSaving(true);
    try {
      await api(`/api/orders/${inspecting.id}/inspections`, { method: "POST", body: { result, notes } });
      toast("success", `Inspection recorded for ${inspecting.order_number}: ${result === "pass" ? "Pass" : "Fail"}`);
      setInspecting(null);
    } catch (err) {
      setFormError(errorText(err)); // the dialog stays open with the notes intact
    } finally {
      setSaving(false);
      reload();
    }
  }

  async function release() {
    if (!releasing || saving) return;
    setSaving(true);
    try {
      await api(`/api/orders/${releasing.id}/release`, { method: "POST" });
      toast("success", `${releasing.order_number} released`);
    } catch (err) {
      toast("error", errorText(err));
    } finally {
      setReleasing(null);
      setSaving(false);
      reload();
    }
  }

  return (
    <>
      <PageHeader title="Quality & Release" description="Inspect finished parts, then release the orders that pass" />
      {error && <div className="mb-4"><Alert kind="error" onRetry={reload}>{error}</Alert></div>}
      {pending.loading && !pending.data && <LoadingBlock />}

      {pending.data && ready.data && history.data && (
        <div className="space-y-6">
          <Card title={`Awaiting inspection (${pending.data.total})`} description="A failed inspection blocks release until the order is inspected again and passes." flush>
            {pending.data.total === 0 ? (
              <EmptyState title="No orders are waiting for inspection" description="Orders appear here after post-processing is complete." />
            ) : (
              <Table label="Orders awaiting inspection">
                <Thead>
                  <Tr><Th>Order</Th><Th>Product</Th><Th>Qty</Th><Th>Status</Th><Th>Release check</Th><Th><span className="sr-only">Actions</span></Th></Tr>
                </Thead>
                <Tbody>
                  {pending.data.items.map((order) => (
                    <Tr key={order.id}>
                      <Td label="Order"><Link href={`/orders/${order.id}`} className="font-semibold text-brand-strong hover:underline">{order.order_number}</Link></Td>
                      <Td label="Product" className="break-words">{order.product}</Td>
                      <Td label="Qty" className="tabular-nums">{order.quantity}</Td>
                      <Td label="Status"><StatusBadge status={order.status} /></Td>
                      <Td label="Release check" className="md:max-w-xs"><ReleaseCheck order={order} /></Td>
                      <Td className="max-md:[&>button]:w-full">
                        <Button onClick={() => openInspection(order)} aria-label={`${order.status === "qc_failed" ? "Re-inspect" : "Inspect"} ${order.order_number}`}>
                          {order.status === "qc_failed" ? "Re-inspect" : "Inspect"}
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
            <Pagination
              page={pending.data.page} pageSize={pending.data.page_size} total={pending.data.total} totalPages={pending.data.total_pages}
              itemName={{ one: "order", many: "orders" }} label="Awaiting inspection"
              onPageChange={pendingPaging.setPage} onPageSizeChange={pendingPaging.setPageSize}
            />
          </Card>

          <Card title={`Ready for release (${ready.data.total})`} description="Releasing is final: released orders become read-only." flush>
            {ready.data.total === 0 ? (
              <EmptyState title="No orders are ready for release" description="Orders appear here after passing inspection." />
            ) : (
              <Table label="Orders ready for release">
                <Thead><Tr><Th>Order</Th><Th>Product</Th><Th>Qty</Th><Th>Release check</Th><Th><span className="sr-only">Actions</span></Th></Tr></Thead>
                <Tbody>
                  {ready.data.items.map((order) => (
                    <Tr key={order.id}>
                      <Td label="Order"><Link href={`/orders/${order.id}`} className="font-semibold text-brand-strong hover:underline">{order.order_number}</Link></Td>
                      <Td label="Product" className="break-words">{order.product}</Td>
                      <Td label="Qty" className="tabular-nums">{order.quantity}</Td>
                      <Td label="Release check" className="md:max-w-xs"><ReleaseCheck order={order} /></Td>
                      <Td className="max-md:[&>button]:w-full">
                        <Button disabled={order.release_blockers.length > 0} onClick={() => setReleasing(order)}
                          aria-label={`Release ${order.order_number}`}>
                          Release
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
            <Pagination
              page={ready.data.page} pageSize={ready.data.page_size} total={ready.data.total} totalPages={ready.data.total_pages}
              itemName={{ one: "order", many: "orders" }} label="Ready for release"
              onPageChange={readyPaging.setPage} onPageSizeChange={readyPaging.setPageSize}
            />
          </Card>

          <Card title="Inspection records" description="Every inspection is kept, newest first" flush>
            {history.data.total === 0 ? (
              <EmptyState title="No inspections recorded yet" />
            ) : (
              <Table label="Inspection records">
                <Thead><Tr><Th>When</Th><Th>Order</Th><Th>Result</Th><Th>Notes</Th></Tr></Thead>
                <Tbody>
                  {history.data.items.map((inspection) => (
                    <Tr key={inspection.id}>
                      <Td label="When" className="whitespace-nowrap text-slate-600">{formatDateTime(inspection.inspected_at)}</Td>
                      <Td label="Order"><Link href={`/orders/${inspection.order_id}`} className="font-semibold text-brand-strong hover:underline">{inspection.order_number}</Link></Td>
                      <Td label="Result"><ResultBadge result={inspection.result} /></Td>
                      <Td label="Notes" className="break-words md:max-w-md">{inspection.notes || "—"}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
            <Pagination
              page={history.data.page} pageSize={history.data.page_size} total={history.data.total} totalPages={history.data.total_pages}
              itemName={{ one: "inspection", many: "inspections" }} label="Inspection records"
              onPageChange={historyPaging.setPage} onPageSizeChange={historyPaging.setPageSize}
            />
          </Card>
        </div>
      )}

      {inspecting && (
        <Dialog
          title={`Inspection for ${inspecting.order_number}`}
          description={`${inspecting.product} × ${inspecting.quantity}. Earlier inspection records are always kept.`}
          onClose={() => setInspecting(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setInspecting(null)} disabled={saving}>Cancel</Button>
              <Button variant={result === "fail" ? "danger" : "primary"} loading={saving} onClick={saveInspection}>
                Record {result === "pass" ? "pass" : "fail"}
              </Button>
            </>
          }
        >
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-800">Result</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["pass", "fail"] as const).map((value) => (
                <label key={value} className="relative block cursor-pointer">
                  <input type="radio" name="result" value={value} checked={result === value}
                    onChange={() => { setResult(value); setNotesError(undefined); }}
                    className="peer absolute inset-0 cursor-pointer opacity-0" />
                  <span className={`flex min-h-12 items-center justify-center gap-2 rounded-control border-2 border-slate-500 bg-white px-3 text-sm font-semibold text-slate-800 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-ring ${
                    value === "pass" ? "peer-checked:border-emerald-600 peer-checked:bg-emerald-50 peer-checked:text-emerald-900"
                      : "peer-checked:border-red-600 peer-checked:bg-red-50 peer-checked:text-red-900"
                  }`}>
                    <span aria-hidden="true">{value === "pass" ? "✓" : "✕"}</span>
                    {value === "pass" ? "Pass" : "Fail"}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <TextAreaField label="Inspection notes" required={result === "fail"} optional={result === "pass"}
            value={notes} onChange={(e) => setNotes(e.target.value)} error={notesError} disabled={saving}
            placeholder={result === "fail" ? "What failed? e.g. surface porosity on the rim" : "Measurements, observations (optional)"}
            hint={result === "fail" ? "A failed inspection blocks release until the order is inspected again and passes." : undefined} />
          {formError && <Alert kind="error" title="The inspection could not be saved">{formError}</Alert>}
        </Dialog>
      )}

      {releasing && (
        <ConfirmDialog
          title={`Release ${releasing.order_number}?`}
          message="All production steps are complete and the latest inspection passed. Released orders become read-only, and this cannot be undone."
          confirmLabel="Release order"
          busy={saving}
          onConfirm={release}
          onCancel={() => setReleasing(null)}
        />
      )}
    </>
  );
}
