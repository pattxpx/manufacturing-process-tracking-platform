import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { API } from "./fixtures";
export { API };

let counter = 0;
/** A unique order number per call, so tests never collide with each other. */
export function newOrderNumber(prefix = "E2E"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString().slice(-6)}-${counter}`;
}

/** Create an order through the API (fast setup for tests that are about something else). */
export async function createOrderViaApi(
  request: APIRequestContext,
  fields: { product?: string; quantity?: number } = {},
) {
  const response = await request.post(`${API}/api/orders`, {
    data: {
      order_number: newOrderNumber(),
      product: fields.product ?? "Hearing Aid Shell",
      quantity: fields.quantity ?? 3,
      design_reference: "DR-E2E-001",
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: number; order_number: string };
}

/** Start + complete the given steps through the API. */
export async function runStepsViaApi(request: APIRequestContext, orderId: number, steps: string[]) {
  for (const step of steps) {
    const started = await request.post(`${API}/api/orders/${orderId}/steps/${step}/start`, { data: {} });
    expect(started.status(), await started.text()).toBe(200);
    const completed = await request.post(`${API}/api/orders/${orderId}/steps/${step}/complete`, { data: {} });
    expect(completed.status(), await completed.text()).toBe(200);
  }
}

/** Pick an option in one of our custom dropdowns (a Radix Select, not a native <select>). */
export async function chooseOption(page: Page, label: string | RegExp, option: string | RegExp) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

/** Create an order through the UI form. */
export async function createOrderViaUi(
  page: Page,
  fields: { orderNumber: string; product: string; quantity: number; designRef: string },
) {
  await page.goto("/orders/new");
  await page.getByLabel("Order number").fill(fields.orderNumber);
  await chooseOption(page, "Product", fields.product);
  await page.getByLabel("Quantity").fill(String(fields.quantity));
  await page.getByLabel("Design reference").fill(fields.designRef);
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByRole("heading", { name: fields.orderNumber })).toBeVisible();
}

/** Create several orders that all share a marker text in their design reference, so a search finds exactly them. */
export async function createMarkedOrders(request: APIRequestContext, count: number, marker: string, product = "Hearing Aid Shell") {
  const orders: { id: number; order_number: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const response = await request.post(`${API}/api/orders`, {
      data: { product, quantity: 1, design_reference: `CAD-${marker}-${i}` },
    });
    expect(response.status()).toBe(201);
    orders.push(await response.json());
  }
  return orders;
}

/** A short random marker such as "pg48213", unique per test run. */
export function newMarker(prefix: string): string {
  return `${prefix}${Date.now().toString().slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
}

/**
 * The board lists the oldest 25 orders of each step first, and the rest on "Show more".
 * A new order joins the end of the first-in-first-out queue, so after many orders it may not be on screen yet.
 */
export async function showOnBoard(page: Page, orderNumber: string) {
  await expect(page.getByRole("region", { name: "Design Review" })).toBeVisible(); // the board has loaded
  const card = page.getByRole("region").getByRole("link", { name: orderNumber, exact: true }).first();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await card.isVisible()) return;
    const more = page.getByRole("button", { name: /^Show \d+ more$/ }).first();
    if (!(await more.isVisible())) break;
    const refreshed = page.waitForResponse((response) => response.url().includes("/api/production/board"));
    await more.click();
    await refreshed;
  }
  await expect(card).toBeVisible();
}
