"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { formatQty } from "@/lib/format";
import type { BoardItem, Machine, Order } from "@/lib/types";
import { Badge } from "./Badge";
import { Dialog } from "./Dialog";
import { Select } from "./Select";
import { Alert, Button } from "./ui";

/** Starting a print job reserves material and takes a printer, so it asks first. */
export function StartPrintingDialog({ order, item, machines, onClose, onStarted }: {
  order: Order; item: Pick<BoardItem, "material_requirements">; machines: Machine[]; onClose: () => void; onStarted: () => void;
}) {
  const [printer, setPrinter] = useState("auto");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstIdle = machines.find((m) => m.status === "idle");
  const options = [
    {
      value: "auto",
      label: "Automatic",
      hint: firstIdle ? `Uses the first available printer (${firstIdle.name})` : "No printer is available right now",
      disabled: !firstIdle,
    },
    ...machines.map((m) => ({
      value: String(m.id),
      label: m.name,
      hint: m.status === "idle" ? "Available" : `Busy, running ${m.current_order_number}`,
      disabled: m.status !== "idle",
    })),
  ];

  async function start() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/orders/${order.id}/steps/printing/start`, {
        method: "POST", body: { machine_id: printer === "auto" ? null : Number(printer) },
      });
      onStarted();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={`Start 3D printing for ${order.order_number}?`}
      description="This takes a printer and reserves the materials below until printing is completed."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button loading={saving} onClick={start}>Start printing</Button>
        </>
      }
    >
      <Select label="Printer" value={printer} onChange={setPrinter} options={options} />
      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-800">Materials to reserve</p>
        <ul className="divide-y divide-slate-100 rounded-control border border-slate-200">
          {item.material_requirements.map((m) => (
            <li key={m.name} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 break-words font-medium text-slate-900">{m.name}</span>
              <span className="text-slate-700">
                <strong className="tabular-nums">{formatQty(m.quantity, m.unit)}</strong>
                <span className="text-xs text-slate-600"> of {formatQty(m.available, m.unit)} available</span>
                {m.available < m.quantity && <> <Badge tone="red">Short</Badge></>}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {error && <Alert kind="error" title="Printing could not be started">{error}</Alert>}
    </Dialog>
  );
}
