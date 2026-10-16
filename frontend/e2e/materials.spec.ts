import { expect, test } from "./fixtures";
import { API, chooseOption, createOrderViaApi, newOrderNumber, runStepsViaApi } from "./helpers";

// This file runs first on a fresh database. Its orders are finished (or blocked by material),
// so they never hold up the first-in-first-out print queue of the other tests.

test("multi-material job: reserve every material, then record actual use per material", async ({ page, request }) => {
  const orderNumber = newOrderNumber();

  // The form shows every material a product needs
  await page.goto("/orders/new");
  await chooseOption(page, "Product", "Custom Surgical Guide");
  await expect(page.getByText("Per unit: 60 ml Medical Photopolymer Resin + 20 ml Isopropyl Alcohol")).toBeVisible();
  await page.getByLabel("Order number").fill(orderNumber);
  await page.getByLabel("Quantity").fill("4"); // 240 ml resin + 80 ml alcohol
  await page.getByLabel("Design reference").fill("DR-SG-MULTI-1");
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("heading", { name: orderNumber })).toBeVisible();

  // Order details list the materials before anything is reserved
  const resinRow = page.getByRole("row", { name: /Medical Photopolymer Resin/ });
  const alcoholRow = page.getByRole("row", { name: /Isopropyl Alcohol/ });
  await expect(resinRow).toContainText("240 ml");
  await expect(resinRow).toContainText("Not reserved");
  await expect(alcoholRow).toContainText("80 ml");
  const orderUrl = page.url();
  const orderId = Number(orderUrl.split("/").pop());

  await runStepsViaApi(request, orderId, ["design_review"]);

  // The queue shows each material with what is in stock
  await page.goto("/production");
  const queueRow = page.getByRole("row").filter({ hasText: orderNumber });
  await expect(queueRow).toContainText("240 ml Medical Photopolymer Resin");
  await expect(queueRow).toContainText("80 ml Isopropyl Alcohol");
  await expect(queueRow).toContainText("available");

  // Starting asks for confirmation and shows both materials that will be reserved
  await page.getByRole("button", { name: `Start 3D Printing for ${orderNumber}` }).click();
  const startDialog = page.getByRole("dialog");
  await expect(startDialog).toContainText("240 ml");
  await expect(startDialog).toContainText("80 ml");
  await startDialog.getByRole("button", { name: "Start printing" }).click();
  await expect(page.getByText(`3D Printing started for ${orderNumber}`)).toBeVisible();
  await page.goto(orderUrl);
  await expect(resinRow).toContainText("Reserved");
  await expect(alcoholRow).toContainText("Reserved");

  // The completion dialog has one input per material, pre-filled with the reservation
  await page.goto("/production");
  await page.getByRole("button", { name: `Complete 3D Printing for ${orderNumber}` }).click();
  const dialog = page.getByRole("dialog");
  const resinInput = dialog.getByLabel("Medical Photopolymer Resin used (ml)");
  const alcoholInput = dialog.getByLabel("Isopropyl Alcohol used (ml)");
  await expect(resinInput).toHaveValue("240");
  await expect(alcoholInput).toHaveValue("80");

  // More than reserved is refused, and nothing is sent
  await alcoholInput.fill("90");
  await dialog.getByRole("button", { name: "Complete printing" }).click();
  await expect(dialog.getByText("Cannot be more than the reserved 80 ml")).toBeVisible();

  // Alcohol used less than reserved. Resin stays at the default.
  await alcoholInput.fill("70");
  await dialog.getByRole("button", { name: "Complete printing" }).click();
  await expect(page.getByText(`3D Printing completed for ${orderNumber}`)).toBeVisible();

  // Usage history has one row per material, with its own reserved and actual quantity
  await page.goto("/resources");
  const rows = page.getByRole("row").filter({ hasText: orderNumber });
  await expect(rows).toHaveCount(2);
  const resinUsage = rows.filter({ hasText: "Medical Photopolymer Resin" });
  const alcoholUsage = rows.filter({ hasText: "Isopropyl Alcohol" });
  await expect(resinUsage).toContainText("Consumed");
  await expect(resinUsage.getByRole("cell", { name: "240 ml" })).toHaveCount(2); // reserved and actual
  await expect(alcoholUsage.getByRole("cell", { name: "80 ml" })).toHaveCount(1);
  await expect(alcoholUsage.getByRole("cell", { name: "70 ml" })).toHaveCount(1);

  // ...and so do the order details
  await page.goto(orderUrl);
  await expect(page.getByRole("row", { name: /Isopropyl Alcohol/ })).toContainText("70 ml");
  await expect(page.getByRole("row", { name: /Isopropyl Alcohol/ })).toContainText("Consumed");
});

test("every short material is listed, and a blocked multi-material order cannot start", async ({ page, request }) => {
  // 1000 plates need 120,000 g titanium (20,000 in stock) and 12,000 L argon (6,000 in stock)
  const order = await createOrderViaApi(request, { product: "Cranial Implant Plate", quantity: 1000 });
  await runStepsViaApi(request, order.id, ["design_review"]);

  await page.goto("/production");
  const queueRow = page.getByRole("row").filter({ hasText: order.order_number });
  await expect(queueRow).toContainText("Insufficient Ti-6Al-4V Powder: needs 120000 g, only 20000 g available");
  await expect(queueRow).toContainText("Insufficient Argon Gas: needs 12000 L, only 6000 L available");
  await expect(page.getByRole("button", { name: `Start 3D Printing for ${order.order_number}` })).toBeDisabled();

  // Nothing was reserved
  const resources = await (await request.get(`${API}/api/resources`)).json();
  expect(resources.every((r: { reserved: number }) => r.reserved === 0)).toBe(true);
});
