"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { formatQty } from "@/lib/format";
import type { Order, Paged, ResourceUsage } from "@/lib/types";
import { Dialog } from "./Dialog";
import { Alert, Button, LoadingBlock, TextField } from "./ui";

/** Completes a printing job. One input per reserved material, pre-filled with the reserved amount. */
export function CompletePrintingDialog({ order, onClose, onCompleted }: {
  order: Order; onClose: () => void; onCompleted: () => void;
}) {
  const [reservations, setReservations] = useState<ResourceUsage[] | null>(null);
  const [values, setValues] = useState<Record<number, string>>({}); // resource id -> text in the input
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<Paged<ResourceUsage>>(`/api/resources/usage?order_id=${order.id}&page_size=100`)
      .then(({ items }) => {
        const open = items.filter((row) => row.status === "reserved").reverse();
        setReservations(open);
        setValues(Object.fromEntries(open.map((row) => [row.resource_id, String(row.reserved_quantity)])));
      })
      .catch((err) => setServerError(errorText(err)));
  }, [order.id]);

  function validate(): boolean {
    const found: Record<number, string> = {};
    for (const row of reservations ?? []) {
      const text = values[row.resource_id].trim();
      if (text === "") continue; // left empty: the reserved amount is used
      const amount = Number(text);
      if (!Number.isInteger(amount) || amount < 1) found[row.resource_id] = "Enter a whole number of 1 or more";
      else if (amount > row.reserved_quantity) {
        found[row.resource_id] = `Cannot be more than the reserved ${row.reserved_quantity} ${row.unit}`;
      }
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function submit() {
    if (saving) return;
    setServerError(null);
    if (!validate()) return;
    setSaving(true);
    try {
      const actual_usage = (reservations ?? [])
        .filter((row) => values[row.resource_id].trim() !== "")
        .map((row) => ({ resource_id: row.resource_id, actual_quantity: Number(values[row.resource_id]) }));
      await api(`/api/orders/${order.id}/steps/printing/complete`, { method: "POST", body: { actual_usage } });
      onCompleted();
    } catch (err) {
      setServerError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={`Complete 3D Printing for ${order.order_number}?`}
      description="Enter what was actually used for each material. Unused material goes back to available stock."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button loading={saving} disabled={!reservations} onClick={submit}>Complete printing</Button>
        </>
      }
    >
      {!reservations && !serverError && <LoadingBlock label="Loading reserved materials…" />}
      {reservations?.map((row) => (
        <TextField
          key={row.resource_id}
          label={`${row.resource_name} used (${row.unit})`}
          type="number" inputMode="numeric" min={1} max={row.reserved_quantity}
          value={values[row.resource_id] ?? ""}
          onChange={(e) => setValues({ ...values, [row.resource_id]: e.target.value })}
          hint={`Reserved: ${formatQty(row.reserved_quantity, row.unit)}. Leave empty to use the reserved amount.`}
          error={errors[row.resource_id]}
          disabled={saving}
        />
      ))}
      {serverError && <Alert kind="error" title="Printing could not be completed">{serverError}</Alert>}
    </Dialog>
  );
}
