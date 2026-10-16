"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { formatDateTime, formatQty } from "@/lib/format";
import { useLiveData, usePagination } from "@/lib/hooks";
import type { Paged, Resource, StockAdjustment } from "@/lib/types";
import { Dialog } from "./Dialog";
import { Pagination } from "./Pagination";
import { Select } from "./Select";
import { Alert, Button, EmptyState, LoadingBlock, Table, Tbody, Td, TextField, Th, Thead, Tr } from "./ui";

const UNITS = ["g", "kg", "ml", "L", "pcs"].map((u) => ({ value: u, label: u }));
const CATEGORIES = ["powder", "resin", "gas", "solvent", "other"].map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }));

/** Create a material, or edit its details. Quantities are never edited here: they change through stock adjustments. */
export function ResourceFormDialog({ resource, onClose, onSaved }: {
  resource?: Resource; onClose: () => void; onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(resource?.name ?? "");
  const [category, setCategory] = useState(resource?.category ?? "other");
  const [unit, setUnit] = useState(resource?.unit ?? "g");
  const [minStock, setMinStock] = useState(String(resource?.min_stock ?? 0));
  const [initial, setInitial] = useState("0");
  const [active, setActive] = useState(resource?.is_active === false ? "inactive" : "active");
  const [errors, setErrors] = useState<{ name?: string; min?: string; initial?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setServerError(null);
    const found: typeof errors = {};
    if (!name.trim()) found.name = "Enter a name.";
    const min = Number(minStock);
    if (!Number.isInteger(min) || min < 0) found.min = "Enter a whole number, 0 or more.";
    const start = Number(initial);
    if (!resource && (!Number.isInteger(start) || start < 0)) found.initial = "Enter a whole number, 0 or more.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      if (resource) {
        await api(`/api/resources/${resource.id}`, {
          method: "PATCH", body: { name: name.trim(), category, unit, min_stock: min, is_active: active === "active" },
        });
      } else {
        await api("/api/resources", {
          method: "POST", body: { name: name.trim(), category, unit, min_stock: min, initial_stock: start },
        });
      }
      onSaved(name.trim());
    } catch (err) {
      setServerError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={resource ? `Edit ${resource.name}` : "Add material"}
      description={resource ? "Details only. To change how much is in stock, use Adjust stock." : "A material is tracked in one unit. Opening stock is recorded as the first stock adjustment."}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} onClick={save}>{resource ? "Save changes" : "Add material"}</Button></>}
    >
      <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} error={errors.name}
        hint={resource ? "Materials that product definitions refer to by name cannot be renamed." : undefined} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Category" value={category} onChange={setCategory} options={CATEGORIES} />
        <Select label="Unit" required value={unit} onChange={setUnit} options={UNITS}
          hint={resource ? "Cannot change once the material has stock history." : undefined} />
      </div>
      <TextField label={`Minimum stock (${unit})`} required type="number" inputMode="numeric" min={0} value={minStock}
        onChange={(e) => setMinStock(e.target.value)} error={errors.min} hint="A low-stock warning shows when available stock falls below this." />
      {!resource && (
        <TextField label={`Opening stock (${unit})`} type="number" inputMode="numeric" min={0} value={initial}
          onChange={(e) => setInitial(e.target.value)} error={errors.initial} optional />
      )}
      {resource && (
        <Select label="Status" value={active} onChange={setActive} options={[
          { value: "active", label: "Active", hint: "Can be reserved for printing" },
          { value: "inactive", label: "Inactive", hint: "Cannot be used. History is kept" },
        ]} />
      )}
      {serverError && <Alert kind="error" title="Not saved">{serverError}</Alert>}
    </Dialog>
  );
}

/** Add or remove stock, always with a reason. The server refuses anything that would leave less than is reserved. */
export function AdjustStockDialog({ resource, onClose, onSaved }: {
  resource: Resource; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const value = Number(amount);
  const change = Number.isInteger(value) && value > 0 ? (direction === "add" ? value : -value) : 0;
  const after = resource.on_hand + change;

  async function save() {
    if (busy) return;
    setServerError(null);
    const found: typeof errors = {};
    if (!Number.isInteger(value) || value < 1) found.amount = "Enter a whole number of 1 or more.";
    else if (direction === "remove" && value > resource.available) {
      found.amount = `Only ${formatQty(resource.available, resource.unit)} is available to remove (the rest is reserved).`;
    }
    if (reason.trim().length < 3) found.reason = "Give a reason, for example 'Delivery note 4711' or 'Stock count'.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await api(`/api/resources/${resource.id}/adjustments`, { method: "POST", body: { quantity_change: change, reason: reason.trim() } });
      onSaved(`${change > 0 ? "Added" : "Removed"} ${formatQty(Math.abs(change), resource.unit)} ${change > 0 ? "to" : "from"} ${resource.name}`);
    } catch (err) {
      setServerError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Adjust stock of ${resource.name}`}
      description={`On hand: ${formatQty(resource.on_hand, resource.unit)} · Reserved: ${formatQty(resource.reserved, resource.unit)} · Available: ${formatQty(resource.available, resource.unit)}`}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} onClick={save}>Record adjustment</Button></>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Action" value={direction} onChange={(v) => setDirection(v as "add" | "remove")}
          options={[{ value: "add", label: "Add stock", hint: "A delivery or a count that found more" }, { value: "remove", label: "Remove stock", hint: "Waste, damage or a count that found less" }]} />
        <TextField label={`Quantity (${resource.unit})`} required type="number" inputMode="numeric" min={1} value={amount}
          onChange={(e) => setAmount(e.target.value)} error={errors.amount} />
      </div>
      <TextField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} error={errors.reason}
        hint="Kept permanently in the history, with your name and the time." />
      {change !== 0 && (
        <p className="text-sm text-slate-800" aria-live="polite">
          On hand will change from <strong>{formatQty(resource.on_hand, resource.unit)}</strong> to <strong>{formatQty(after, resource.unit)}</strong>.
        </p>
      )}
      {serverError && <Alert kind="error" title="Not recorded">{serverError}</Alert>}
    </Dialog>
  );
}

/** Every stock adjustment of a material, newest first. It can only grow: nothing here can be edited or deleted. */
export function StockHistoryDialog({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const { page, pageSize, setPage, setPageSize } = usePagination(10);
  const { data, error, loading, reload } = useLiveData(
    () => api<Paged<StockAdjustment>>(`/api/resources/${resource.id}/adjustments?page=${page}&page_size=${pageSize}`),
    [resource.id, page, pageSize],
  );
  return (
    <Dialog title={`Stock history of ${resource.name}`} description="Every change to the quantity on hand. Entries cannot be edited or deleted."
      onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {error && <Alert kind="error" onRetry={reload}>{error}</Alert>}
      {loading && !data && <LoadingBlock />}
      {data && data.items.length === 0 && <EmptyState title="No adjustments yet" description="Reservations and usage by print jobs are in the usage history." />}
      {data && data.items.length > 0 && (
        <div className="-mx-4 sm:-mx-5">
          <Table label={`Stock history of ${resource.name}`}>
            <Thead><Tr><Th>When</Th><Th>Change</Th><Th>On hand</Th><Th>Reason</Th><Th>By</Th></Tr></Thead>
            <Tbody>
              {data.items.map((a) => (
                <Tr key={a.id}>
                  <Td label="When" className="whitespace-nowrap">{formatDateTime(a.created_at)}</Td>
                  <Td label="Change" className="font-semibold tabular-nums">{a.quantity_change > 0 ? "+" : "−"}{formatQty(Math.abs(a.quantity_change), a.unit)}</Td>
                  <Td label="On hand" className="tabular-nums">{formatQty(a.on_hand_before, a.unit)} → {formatQty(a.on_hand_after, a.unit)}</Td>
                  <Td label="Reason" className="break-words">{a.reason}</Td>
                  <Td label="By" className="break-all">{a.actor_username}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} totalPages={data.total_pages}
            itemName={{ one: "adjustment", many: "adjustments" }} label="Stock history"
            onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>
      )}
    </Dialog>
  );
}
