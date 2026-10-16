import { expect, test } from "./fixtures";
import { API, createOrderViaApi, createOrderViaUi, newOrderNumber, runStepsViaApi, showOnBoard } from "./helpers";

test("complete the whole workflow and release the order", async ({ page }) => {
  const orderNumber = newOrderNumber();
  await createOrderViaUi(page, {
    orderNumber, product: "Titanium Spinal Cage", quantity: 10, designRef: "DR-SC-777-A",
  });

  await page.goto("/production");
  await showOnBoard(page, orderNumber); // it is last in the queue
  const start = (step: string) => page.getByRole("button", { name: `Start ${step} for ${orderNumber}` });
  const complete = (step: string) => page.getByRole("button", { name: `Complete ${step} for ${orderNumber}` });

  // 1. Design review (completion asks for confirmation)
  await start("Design Review").click();
  await complete("Design Review").click();
  await page.getByRole("dialog").getByRole("button", { name: "Complete step" }).click();

  // 2. Printing reserves material, takes a printer, and completing it consumes the material
  await start("3D Printing").click();
  await page.getByRole("dialog").getByRole("button", { name: "Start printing" }).click();
  await expect(page.getByRole("region", { name: "Printers" }).getByText(orderNumber)).toBeVisible();
  await complete("3D Printing").click();
  await page.getByRole("dialog").getByRole("button", { name: "Complete printing" }).click();
  await expect(start("Post-processing")).toBeEnabled();

  // 3. Post-processing
  await start("Post-processing").click();
  await complete("Post-processing").click();
  await page.getByRole("dialog").getByRole("button", { name: "Complete step" }).click();
  await expect(page.getByRole("link", { name: "Inspect" }).first()).toBeVisible();

  // 4. Quality inspection: pass
  await page.goto("/quality");
  await page.getByRole("button", { name: `Inspect ${orderNumber}` }).click();
  await page.getByLabel("Inspection notes").fill("Dimensions within tolerance");
  await page.getByRole("button", { name: "Record pass" }).click();
  await expect(page.getByText(`Inspection recorded for ${orderNumber}: Pass`)).toBeVisible();

  // 5. Release (with confirmation)
  await page.getByRole("button", { name: `Release ${orderNumber}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Release order" }).click();
  await expect(page.getByText(`${orderNumber} released`)).toBeVisible();

  // Released order is read-only
  await page.goto("/orders");
  await page.getByLabel("Search orders").fill(orderNumber);
  await page.getByRole("link", { name: orderNumber }).click();
  await expect(page.getByText("released and is now read-only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);

  // The material was consumed: usage history shows 400 g used for this order
  await page.goto("/resources");
  const row = page.getByRole("row").filter({ hasText: orderNumber });
  await expect(row).toContainText("Consumed");
  await expect(row).toContainText("400 g");
});

test("insufficient material blocks printing and explains why", async ({ page, request }) => {
  // 1000 x 120 g = 120,000 g, far more than the 20,000 g of titanium powder in stock
  const order = await createOrderViaApi(request, { product: "Cranial Implant Plate", quantity: 1000 });
  await runStepsViaApi(request, order.id, ["design_review"]);

  await page.goto("/production");
  // Cranial plates need two materials and BOTH are short: both are reported
  await expect(page.getByText(/Insufficient Ti-6Al-4V Powder/).first()).toBeVisible();
  await expect(page.getByText(/Insufficient Argon Gas/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: `Start 3D Printing for ${order.order_number}` })).toBeDisabled();

  // The backend enforces it too, even if someone bypasses the UI
  const response = await request.post(`${API}/api/orders/${order.id}/steps/printing/start`, { data: {} });
  expect(response.status()).toBe(409);
  const detail = (await response.json()).detail;
  expect(detail).toContain("Insufficient Ti-6Al-4V Powder");
  expect(detail).toContain("Insufficient Argon Gas");

  // An older blocked order does not hold up other orders
  const other = await createOrderViaApi(request, { product: "Hearing Aid Shell", quantity: 2 });
  await runStepsViaApi(request, other.id, ["design_review", "printing"]);
});

test("failed inspection blocks release until the order passes", async ({ page, request }) => {
  const order = await createOrderViaApi(request);
  await runStepsViaApi(request, order.id, ["design_review", "printing", "post_processing"]);

  await page.goto("/quality");
  await page.getByRole("button", { name: `Inspect ${order.order_number}` }).click();
  await page.getByLabel("Fail").check();

  // Notes are required for a failure
  await page.getByRole("button", { name: "Record fail" }).click();
  await expect(page.getByText("Notes are required when an inspection fails")).toBeVisible();

  await page.getByLabel("Inspection notes").fill("Surface porosity on rim");
  await page.getByRole("button", { name: "Record fail" }).click();
  await expect(page.getByText(`Inspection recorded for ${order.order_number}: Fail`)).toBeVisible();

  // The order is still waiting (for re-inspection) and release is blocked, with reasons
  const row = page.getByRole("row").filter({ hasText: order.order_number }).first();
  await expect(row).toContainText("QC failed");
  await expect(row).toContainText("The latest inspection failed");
  await expect(page.getByRole("button", { name: `Release ${order.order_number}` })).toHaveCount(0);

  const blocked = await request.post(`${API}/api/orders/${order.id}/release`);
  expect(blocked.status()).toBe(409);

  // Re-inspect: the earlier failed record is kept
  await page.getByRole("button", { name: `Inspect ${order.order_number}` }).click();
  await page.getByRole("button", { name: "Record pass" }).click();
  await expect(page.getByRole("button", { name: `Release ${order.order_number}` })).toBeEnabled();
  await expect(page.getByRole("row").filter({ hasText: "Surface porosity on rim" })).toBeVisible();
});

test("the board updates by itself when something happens elsewhere", async ({ page, request }) => {
  await page.goto("/production");
  await expect(page.getByText("Live updates on")).toBeVisible();

  // Another user creates an order: the step's count goes up without reloading this page.
  // (The card itself joins the end of the first-in-first-out queue, which may be beyond the first 25 shown.)
  const design = page.getByRole("region", { name: "Design Review" });
  const total = async () => Number(/([\d,]+) orders?/.exec((await design.locator("header").textContent()) ?? "")![1].replace(/,/g, ""));
  const before = await total();
  const order = await createOrderViaApi(request);
  await expect.poll(total).toBe(before + 1);

  // ...and when they start its first step, it is listed (running orders are always shown first)
  await request.post(`${API}/api/orders/${order.id}/steps/design_review/start`, { data: {} });
  await expect(page.getByRole("button", { name: `Complete Design Review for ${order.order_number}` })).toBeVisible();
  await request.post(`${API}/api/orders/${order.id}/steps/design_review/complete`, { data: {} });
  await expect(page.getByRole("region", { name: "3D Printing" }).getByText(order.order_number)).toBeVisible();

  // Finish it, so it does not sit in the FIFO print queue for the tests that run after this one
  await runStepsViaApi(request, order.id, ["printing"]);
});
