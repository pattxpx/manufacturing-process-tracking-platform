import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { API, createOrderViaApi, runStepsViaApi } from "./helpers";

// Custom dropdowns (Radix Select). This file runs first and leaves the print queue empty.

/**
 * Radix moves the highlight a moment after a key press (opening, arrows, type-ahead).
 * People never notice, but a script that presses the next key instantly would act on the old option.
 * So wait until the expected option is highlighted before pressing Enter.
 */
async function waitForHighlightedOption(page: Page, name?: string) {
  const highlighted = page.locator('[role="option"][data-highlighted]');
  await expect(highlighted).toHaveCount(1);
  if (name) await expect(highlighted).toContainText(name);
}

test("filter dropdown: keyboard, Escape and outside click", async ({ page, request }) => {
  const fresh = await createOrderViaApi(request); // status: New
  const started = await createOrderViaApi(request);
  await request.post(`${API}/api/orders/${started.id}/steps/design_review/start`, { data: {} }); // In production

  await page.goto("/orders");
  const status = page.getByRole("combobox", { name: "Filter by status" });
  const listbox = page.getByRole("listbox");
  await expect(page.getByRole("link", { name: fresh.order_number })).toBeVisible();
  await expect(page.getByRole("link", { name: started.order_number })).toBeVisible();

  // Enter opens, ArrowDown moves, Enter chooses (All statuses -> New)
  await status.focus();
  await page.keyboard.press("Enter");
  await expect(listbox).toBeVisible();
  await waitForHighlightedOption(page, "All statuses");
  await page.keyboard.press("ArrowDown");
  await waitForHighlightedOption(page, "New");
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(status).toContainText("New");
  await expect(page.getByRole("link", { name: fresh.order_number })).toBeVisible();
  await expect(page.getByRole("link", { name: started.order_number })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear filters" }).first()).toBeVisible();

  // Space opens too; Escape closes without changing the value
  await status.focus();
  await page.keyboard.press("Space");
  await expect(listbox).toBeVisible();
  await waitForHighlightedOption(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(status).toContainText("New");
  await expect(status).toBeFocused(); // focus returns to the control

  // Type-ahead
  await page.keyboard.press("Enter");
  await waitForHighlightedOption(page);
  await page.keyboard.type("In prod");
  await waitForHighlightedOption(page, "In production");
  await page.keyboard.press("Enter");
  await expect(status).toContainText("In production");
  await expect(page.getByRole("link", { name: started.order_number })).toBeVisible();

  // Clicking outside closes it without choosing
  await status.click();
  await expect(listbox).toBeVisible();
  // (While the menu is open the rest of the page is hidden from assistive technology and ignores
  // pointer events, so click on empty page space with the mouse like a user would.)
  await page.mouse.click(600, 30);
  await expect(listbox).toBeHidden();
  await expect(status).toContainText("In production");

  // Clear filters resets the dropdown and shows everything again
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(status).toContainText("All statuses");
  await expect(page.getByRole("link", { name: fresh.order_number })).toBeVisible();
});

test("form dropdown can be used with the keyboard only", async ({ page }) => {
  await page.goto("/orders/new");
  const product = page.getByRole("combobox", { name: "Product" });
  await expect(product).toBeEnabled(); // it is disabled for a moment while the product list loads
  await product.focus();
  await page.keyboard.press("ArrowDown");
  await waitForHighlightedOption(page);
  await page.keyboard.type("Hearing");
  await waitForHighlightedOption(page, "Hearing Aid Shell");
  await page.keyboard.press("Enter");
  await expect(product).toContainText("Hearing Aid Shell");
  await expect(page.getByText("Per unit: 8 ml Medical Photopolymer Resin")).toBeVisible();
});

test("dropdown inside a dialog: busy printers are disabled, Escape closes only the dropdown", async ({ page, request }) => {
  const orders = [];
  for (let i = 0; i < 3; i++) {
    const order = await createOrderViaApi(request, { quantity: 2 });
    await runStepsViaApi(request, order.id, ["design_review"]);
    orders.push(order);
  }
  const [first, second, third] = orders;
  // Two printers are now busy (Printer 1 and Printer 2)
  for (const order of [first, second]) {
    const started = await request.post(`${API}/api/orders/${order.id}/steps/printing/start`, { data: {} });
    expect(started.status()).toBe(200);
  }

  await page.goto("/production");
  await page.getByRole("button", { name: `Start 3D Printing for ${third.order_number}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Materials to reserve");

  const printer = dialog.getByRole("combobox", { name: "Printer" });
  await printer.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await expect(page.getByRole("option", { name: /^Printer 1/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("option", { name: /^Printer 2/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("option", { name: /^Printer 3/ })).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("option", { name: /^Printer 1/ })).toContainText("Busy, running");

  // The menu is not clipped by the dialog: it is fully inside the viewport
  const box = await listbox.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

  // Escape closes the dropdown first, and the dialog is still open
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(printer).toBeFocused();

  // Choose Printer 3, then start
  await printer.click();
  await page.getByRole("option", { name: /^Printer 3/ }).click();
  await expect(listbox).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(printer).toContainText("Printer 3");

  // A second Escape closes the dialog
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: `Start 3D Printing for ${third.order_number}` }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: /^Printer 3/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start printing" }).click();
  await expect(page.getByText(`3D Printing started for ${third.order_number}`)).toBeVisible();

  const machines = await (await request.get(`${API}/api/machines`)).json();
  expect(machines.find((m: { name: string }) => m.name === "Printer 3").current_order_number).toBe(third.order_number);

  // Leave the print queue clean for the other tests
  for (const order of orders) {
    const done = await request.post(`${API}/api/orders/${order.id}/steps/printing/complete`, { data: {} });
    expect(done.status()).toBe(200);
  }
});

test.describe("touch screen", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("dropdown opens and selects by tap and stays on screen", async ({ page }) => {
    await page.goto("/orders/new");
    await page.getByRole("combobox", { name: "Product" }).tap();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const box = await listbox.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);

    // Touch targets are at least 44px tall
    const option = page.getByRole("option", { name: "Custom Surgical Guide" });
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await option.tap();
    await expect(listbox).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Product" })).toContainText("Custom Surgical Guide");
  });
});
