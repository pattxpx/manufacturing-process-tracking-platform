"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { useLiveData } from "@/lib/hooks";
import type { Order, Product } from "@/lib/types";
import { Select } from "./Select";
import { Alert, Button, TextAreaField, TextField } from "./ui";

interface FormValues {
  order_number: string; product: string; quantity: string; design_reference: string; notes: string;
}

const LOCKED_HINT = "Locked: production has started";

/** Create or edit an order. Pass `order` to edit. */
export function OrderForm({ order, onSaved, onCancel }: {
  order?: Order; onSaved: (order: Order) => void; onCancel: () => void;
}) {
  const { data: products, loading: productsLoading, error: productsError } =
    useLiveData(() => api<Product[]>("/api/products"));
  const [values, setValues] = useState<FormValues>({
    order_number: order?.order_number ?? "",
    product: order?.product ?? "",
    quantity: order ? String(order.quantity) : "",
    design_reference: order?.design_reference ?? "",
    notes: order?.notes ?? "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Production-critical fields are locked once production has started (the backend enforces this too).
  const locked = order ? !order.can_edit_production_fields : false;
  const setText = (field: keyof FormValues) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues({ ...values, [field]: e.target.value });

  function validate() {
    const found: typeof errors = {};
    if (!values.product) found.product = "Choose a product from the list.";
    const quantity = Number(values.quantity);
    if (values.quantity.trim() === "") found.quantity = "Enter how many units to make.";
    else if (!Number.isInteger(quantity) || quantity < 1) found.quantity = "Enter a whole number of 1 or more.";
    if (!values.design_reference.trim()) found.design_reference = "Enter the design reference, e.g. CAD-CIP-001-v2.1.";
    setErrors(found);
    return found;
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return; // never submit twice
    const form = e.currentTarget;
    setServerError(null);
    if (Object.keys(validate()).length > 0) {
      // Move keyboard and screen reader focus to the first problem
      setTimeout(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setSaving(true);
    try {
      const body = {
        order_number: values.order_number.trim() || undefined,
        product: values.product,
        quantity: Number(values.quantity),
        design_reference: values.design_reference.trim(),
        notes: values.notes.trim() || null,
      };
      // When editing, only send what is allowed to change.
      const payload = locked ? { notes: body.notes } : body;
      const saved = order
        ? await api<Order>(`/api/orders/${order.id}`, { method: "PATCH", body: payload })
        : await api<Order>("/api/orders", { method: "POST", body });
      onSaved(saved);
    } catch (err) {
      setServerError(errorText(err)); // the typed values stay in the form
      setSaving(false);
    }
  }

  const selectedProduct = products?.find((p) => p.name === values.product);
  const productOptions = (products ?? []).map((p) => ({ value: p.name, label: p.name }));

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <p className="text-xs text-slate-600"><span aria-hidden="true" className="text-red-600">*</span> Required field</p>
      {serverError && <Alert kind="error" title="The order could not be saved">{serverError}</Alert>}
      {productsError && <Alert kind="error" title="Products could not be loaded">{productsError}</Alert>}
      {locked && (
        <Alert kind="warning" title="Some fields are locked">
          Production has started, so the order number, product, quantity and design reference can no longer be changed.
          You can still edit the notes.
        </Alert>
      )}

      <fieldset className="space-y-4">
        <legend className="mb-3 text-sm font-semibold text-slate-900">Order</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Order number" optional value={values.order_number} onChange={setText("order_number")}
            disabled={locked} maxLength={30} placeholder="Generated automatically"
            hint={locked ? LOCKED_HINT : "Leave empty to generate the next number. Must be unique."} error={errors.order_number}
          />
          <Select
            label="Product" required value={values.product}
            onChange={(product) => setValues({ ...values, product })}
            options={productOptions} placeholder="Select a product…"
            disabled={locked} loading={productsLoading} error={errors.product}
            hint={locked ? LOCKED_HINT : selectedProduct
              ? "Per unit: " + selectedProduct.materials.map((m) => `${m.per_unit} ${m.unit} ${m.name}`).join(" + ")
              : "The product decides which materials are used."}
          />
          <TextField
            label="Quantity" required type="number" inputMode="numeric" min={1} step={1}
            value={values.quantity} onChange={setText("quantity")} placeholder="e.g. 25"
            disabled={locked} error={errors.quantity} hint={locked ? LOCKED_HINT : "Number of units to manufacture."}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-3 text-sm font-semibold text-slate-900">Design and notes</legend>
        <TextField
          label="Design reference" required value={values.design_reference} onChange={setText("design_reference")}
          disabled={locked} maxLength={100} placeholder="CAD-CIP-001-v2.1" spellCheck={false}
          hint={locked ? LOCKED_HINT : "The approved CAD file and version, e.g. CAD-CIP-001-v2.1."} error={errors.design_reference}
        />
        <TextAreaField label="Notes" optional value={values.notes} onChange={setText("notes")} maxLength={1000}
          placeholder="Anything the production team should know" />
      </fieldset>

      <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" loading={saving}>{order ? "Save changes" : "Create order"}</Button>
      </div>
    </form>
  );
}
