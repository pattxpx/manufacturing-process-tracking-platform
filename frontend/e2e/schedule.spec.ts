import { expect, test } from "./fixtures";
import { API, createOrderViaApi } from "./helpers";

// Manual scheduling. The test backend shows times in Asia/Bangkok (UTC+7); the server stores UTC.

/** "2026-10-20T09:00" for tomorrow at that hour, as typed in Bangkok. */
function tomorrowInBangkok(hour: string, daysAhead = 1): string {
  const date = new Date(Date.now() + daysAhead * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  return `${date}T${hour}`;
}

test("plan an order from the schedule page: the time zone is converted and the plan shows everywhere", async ({ page, request }) => {
  const order = await createOrderViaApi(request, { product: "Hearing Aid Shell", quantity: 2 });
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Plan print" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("does not start anything or reserve material");

  await dialog.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: /^Printer 2/ }).click();
  await dialog.getByLabel(/Planned start/).fill(tomorrowInBangkok("09:00", 2));
  await dialog.getByLabel("Estimated duration (minutes)").fill("90");
  await dialog.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByText("Plan saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reschedule print" })).toBeVisible(); // the order page knows it is planned

  // 09:00 in Bangkok is 02:00 UTC: that is what the server stored
  const stored = await (await request.get(`${API}/api/orders/${order.id}`)).json();
  expect(new Date(stored.planned_start_at).toISOString()).toBe(new Date(`${tomorrowInBangkok("09:00", 2)}:00+07:00`).toISOString());
  expect(new Date(stored.planned_start_at).getUTCHours()).toBe(2);
  expect(stored.planned_machine_id).toBe(2);
  expect(new Date(stored.planned_end_at).getTime() - new Date(stored.planned_start_at).getTime()).toBe(90 * 60000);

  // It is listed under planned jobs (two days ahead is inside the default three-day window)
  await page.goto("/schedule");
  const planned = page.getByRole("table", { name: "Planned jobs" }).getByRole("row").filter({ hasText: order.order_number });
  await expect(planned).toContainText("Printer 2");
  await expect(planned).toContainText("Planned");
  await expect(planned).toContainText("09:00");  // shown in the configured time zone, not UTC
  await expect(page.getByTestId("schedule-timeline")).toContainText(order.order_number);

  // The order page shows the plan too
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByText("Planned print time")).toBeVisible();
  await expect(page.getByText(/Printer 2:.*09:00.*\(90 min\)/).first()).toBeVisible();
});

test("overlapping plans on one printer are refused with a clear reason, and the dialog keeps your input", async ({ page, request }) => {
  const first = await createOrderViaApi(request, { quantity: 1 });
  const second = await createOrderViaApi(request, { quantity: 1 });
  const slot = tomorrowInBangkok("13:00", 3);
  const planned = await request.put(`${API}/api/orders/${first.id}/schedule`, {
    data: { machine_id: 1, planned_start_at: new Date(new Date(`${slot}:00+07:00`)).toISOString(), estimated_duration_minutes: 120 },
  });
  expect(planned.status()).toBe(200);

  await page.goto(`/orders/${second.id}`);
  await page.getByRole("button", { name: "Plan print" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Planned start/).fill(tomorrowInBangkok("14:00", 3)); // inside the first job's slot
  await dialog.getByLabel("Estimated duration (minutes)").fill("30");
  await dialog.getByRole("button", { name: "Save plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText(first.order_number);
  await expect(dialog.getByRole("alert")).toContainText("Choose another time or printer");
  await expect(dialog.getByLabel("Estimated duration (minutes)")).toHaveValue("30"); // kept

  // Same time on another printer is fine
  await dialog.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: /^Printer 3/ }).click();
  await dialog.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByText("Plan saved")).toBeVisible();
});

test("validation: a missing start and a silly duration are explained", async ({ page, request }) => {
  const order = await createOrderViaApi(request, { quantity: 1 });
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Plan print" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Planned start/).fill("");
  await dialog.getByLabel("Estimated duration (minutes)").fill("0");
  await dialog.getByRole("button", { name: "Save plan" }).click();
  await expect(dialog.getByText("Choose the planned start.")).toBeVisible();
  await expect(dialog.getByText(/whole minutes, from 1 to 10,080/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("reschedule and remove a plan", async ({ page, request }) => {
  const order = await createOrderViaApi(request, { quantity: 1 });
  const slot = new Date(`${tomorrowInBangkok("16:00", 4)}:00+07:00`).toISOString();
  await request.put(`${API}/api/orders/${order.id}/schedule`, { data: { machine_id: 3, planned_start_at: slot, estimated_duration_minutes: 60 } });

  await page.goto("/schedule");
  await page.getByRole("button", { name: "Later" }).click(); // the window moves three days on: the plan is four days ahead
  const jobs = page.getByRole("table", { name: "Planned jobs" });
  const row = jobs.getByRole("row").filter({ hasText: order.order_number });
  await row.getByRole("button", { name: `Reschedule ${order.order_number}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Estimated duration (minutes)")).toHaveValue("60"); // the current plan is filled in
  await dialog.getByLabel("Estimated duration (minutes)").fill("45");
  await dialog.getByRole("button", { name: "Save new plan" }).click();
  await expect(page.getByText(`Plan saved for ${order.order_number}`)).toBeVisible();
  await expect(row).toContainText("45");

  await row.getByRole("button", { name: `Remove plan of ${order.order_number}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove plan" }).click();
  await expect(page.getByText(`Plan removed for ${order.order_number}`)).toBeVisible();
  await expect(row).toHaveCount(0);
  const after = await (await request.get(`${API}/api/orders/${order.id}`)).json();
  expect(after.planned_start_at).toBeNull();
});

test("the schedule page lists the oldest orders without a plan and can plan them", async ({ page, request }) => {
  await createOrderViaApi(request, { quantity: 1 });
  await page.goto("/schedule");
  const list = page.getByRole("table", { name: "Orders without a plan" });
  await expect(list.getByRole("row").nth(1)).toBeVisible();
  await list.getByRole("row").nth(1).getByRole("button", { name: /^Plan / }).click();
  await expect(page.getByRole("dialog")).toContainText("This is a plan only");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("an order that is already printing cannot be re-planned", async ({ request }) => {
  const order = await createOrderViaApi(request, { quantity: 1 });
  await request.put(`${API}/api/orders/${order.id}/schedule`, {
    data: { machine_id: 1, planned_start_at: new Date(Date.now() + 5 * 86400000).toISOString(), estimated_duration_minutes: 30 },
  });
  // design review -> printing (it is first in the queue here), then printing starts
  await request.post(`${API}/api/orders/${order.id}/steps/design_review/start`, { data: {} });
  await request.post(`${API}/api/orders/${order.id}/steps/design_review/complete`, { data: {} });
  const started = await request.post(`${API}/api/orders/${order.id}/steps/printing/start`, { data: {} });
  expect(started.status()).toBe(200);
  const moved = await request.put(`${API}/api/orders/${order.id}/schedule`, {
    data: { machine_id: 2, planned_start_at: new Date(Date.now() + 6 * 86400000).toISOString(), estimated_duration_minutes: 30 },
  });
  expect(moved.status()).toBe(409);
  expect((await moved.json()).detail).toContain("can no longer be changed");
  const detail = await (await request.get(`${API}/api/orders/${order.id}`)).json();
  expect(detail.can_plan).toBe(false); // so the order page does not even offer the button
  await request.post(`${API}/api/orders/${order.id}/steps/printing/complete`, { data: {} }); // leave the queue clean
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the timeline gives way to the list, and nothing overflows", async ({ page, request }) => {
    await createOrderViaApi(request, { quantity: 1 });
    await page.goto("/schedule");
    await expect(page.getByRole("heading", { name: "Schedule", level: 1 })).toBeVisible();
    await expect(page.getByTestId("schedule-timeline")).toBeHidden();
    await expect(page.getByText("The timeline needs a wider screen")).toBeVisible();
    await expect(page.getByRole("table", { name: "Orders without a plan" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
