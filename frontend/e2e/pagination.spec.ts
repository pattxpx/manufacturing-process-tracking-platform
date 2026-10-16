import { adminRequest, expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  API, chooseOption, createMarkedOrders, createOrderViaApi, newMarker, runStepsViaApi,
} from "./helpers";

// Server-side pagination, debounced search and live updates on the Orders list, plus the
// pagination of the Quality and Resources lists.

const summary = (page: Page, text: string | RegExp) => page.getByText(text).first();

/** Type in the search box and wait until that search has really been applied (typing is debounced). */
async function search(page: Page, text: string) {
  const answered = page.waitForResponse((response) => response.url().includes(`search=${encodeURIComponent(text)}`));
  await page.getByLabel("Search orders").fill(text);
  await answered;
}
const next = (page: Page) => page.getByRole("button", { name: "Next" }).first();
const previous = (page: Page) => page.getByRole("button", { name: "Previous" }).first();

test.describe("orders list", () => {
  const marker = newMarker("pg");

  test.beforeAll(async ({ playwright }) => {
    const request = await adminRequest(playwright);
    await createMarkedOrders(request, 60, marker);
    await request.dispose();
  });

  async function searchFor(page: Page, text: string) {
    await page.goto("/orders");
    await search(page, text);
  }

  test("pages forward and back with the right range, and disables the ends", async ({ page }) => {
    await searchFor(page, marker);
    await expect(summary(page, "Showing 1–25 of 60 orders")).toBeVisible();
    await expect(previous(page)).toBeDisabled();
    await expect(next(page)).toBeEnabled();
    await expect(page.getByRole("row")).toHaveCount(26); // 25 orders + the header row

    await next(page).click();
    await expect(summary(page, "Showing 26–50 of 60 orders")).toBeVisible();
    await expect(page.getByRole("button", { name: "Page 2", exact: true })).toHaveAttribute("aria-current", "page");

    await next(page).click();
    await expect(summary(page, "Showing 51–60 of 60 orders")).toBeVisible();
    await expect(next(page)).toBeDisabled();
    await expect(page.getByRole("row")).toHaveCount(11); // the last, shorter page

    await previous(page).click();
    await expect(summary(page, "Showing 26–50 of 60 orders")).toBeVisible();
  });

  test("changing page size, search or a filter starts again on page 1", async ({ page }) => {
    await searchFor(page, marker);
    await expect(summary(page, "Showing 1–25 of 60 orders")).toBeVisible();

    await chooseOption(page, "Rows per page for orders", "10");
    await expect(summary(page, "Showing 1–10 of 60 orders")).toBeVisible();

    await next(page).click();
    await next(page).click();
    await expect(summary(page, "Showing 21–30 of 60 orders")).toBeVisible();

    // A filter change goes back to page 1 (and keeps the page size and the search)
    await chooseOption(page, "Filter by status", "New");
    await expect(summary(page, "Showing 1–10 of 60 orders")).toBeVisible();

    await next(page).click();
    await expect(summary(page, "Showing 11–20 of 60 orders")).toBeVisible();
    // A new search too: 12 orders contain "-1" at the end of the reference, e.g. "-1", "-10".."-19"
    await search(page, `${marker}-1`);
    await expect(summary(page, "Showing 1–10 of 11 orders")).toBeVisible();
  });

  test("typing is not searched until the user pauses, and only the last text is sent", async ({ page }) => {
    const sent: (string | null)[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/orders") sent.push(url.searchParams.get("search"));
    });
    await page.goto("/orders");
    await expect(page.getByRole("row").nth(1)).toBeVisible();
    sent.length = 0;

    const box = page.getByLabel("Search orders");
    const answered = page.waitForResponse((response) => response.url().includes(`search=${marker}`));
    await box.pressSequentially(marker, { delay: 20 }); // far faster than the 300 ms pause
    await expect(box).toHaveValue(marker);                // the box itself is never delayed
    await answered;

    expect(sent).toEqual([marker]); // one request, with the complete text; none for the half-typed words
    await expect(summary(page, /Showing 1–25 of \d+ orders/)).toBeVisible();
  });

  test("a slow old search can never replace the result of a newer one", async ({ page }) => {
    await page.route("**/api/orders?*", async (route) => {
      if (route.request().url().includes("search=slow")) await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto("/orders");
    const box = page.getByLabel("Search orders");

    await box.fill("slowzzz");
    await page.waitForRequest((request) => request.url().includes("search=slowzzz")); // now in flight, delayed
    await box.fill(marker);
    await expect(summary(page, "Showing 1–25 of 60 orders")).toBeVisible();

    // Let the old answer (zero matches) arrive. It must be ignored.
    await page.waitForResponse((response) => response.url().includes("slowzzz"));
    await expect(summary(page, "Showing 1–25 of 60 orders")).toBeVisible();
    await expect(page.getByText("No orders match your filters")).toHaveCount(0);
  });

  test("no results, then clearing the search", async ({ page }) => {
    await searchFor(page, "zzz-no-such-order");
    await expect(page.getByText("No orders match your filters")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "orders pages" })).toHaveCount(0); // nothing to page through

    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(page.getByLabel("Search orders")).toHaveValue("");
    await expect(page.getByText("No orders match your filters")).toHaveCount(0);
    await expect(page.getByRole("row").nth(1)).toBeVisible();
  });

  test("a link with a filter in the address starts with that filter", async ({ page }) => {
    await page.goto("/orders?status=qc_failed");
    await expect(page.getByRole("combobox", { name: "Filter by status" })).toContainText("QC failed");
    await page.goto(`/orders?search=${marker}-5&step=design_review`);
    await expect(page.getByLabel("Search orders")).toHaveValue(`${marker}-5`);
    await expect(page.getByRole("combobox", { name: "Filter by step" })).toContainText("Design Review");
  });
});

test.describe("live updates on a paginated list", () => {
  test("a new matching order raises the total without a reload", async ({ page, request }) => {
    const marker = newMarker("lv");
    await createMarkedOrders(request, 3, marker);
    await page.goto("/orders");
    await search(page, marker);
    await expect(summary(page, "Showing 1–3 of 3 orders")).toBeVisible();

    await createMarkedOrders(request, 1, marker);
    await expect(summary(page, "Showing 1–4 of 4 orders")).toBeVisible();
  });

  test("when the current page stops existing, the list moves to the last valid page", async ({ page, request }) => {
    const marker = newMarker("rm");
    const orders = await createMarkedOrders(request, 26, marker); // newest first: page 2 holds the oldest order
    await page.goto("/orders");
    await search(page, marker);
    await chooseOption(page, "Filter by status", "New");
    await expect(summary(page, "Showing 1–25 of 26 orders")).toBeVisible();
    await next(page).click();
    await expect(summary(page, "Showing 26–26 of 26 orders")).toBeVisible();

    // Someone starts that order elsewhere: it is no longer "New", so page 2 no longer exists
    const started = await request.post(`${API}/api/orders/${orders[0].id}/steps/design_review/start`, { data: {} });
    expect(started.status()).toBe(200);

    await expect(summary(page, "Showing 1–25 of 25 orders")).toBeVisible();
    await expect(next(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Page 1", exact: true })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("search and pagination are usable and fit the screen", async ({ page, request }) => {
    const marker = newMarker("mb");
    await createMarkedOrders(request, 30, marker);
    await page.goto("/orders");
    await search(page, marker);
    await expect(summary(page, "Showing 1–25 of 30 orders")).toBeVisible();

    // Short "Page 1 of 2" instead of numbered buttons, with large Previous/Next buttons
    await expect(page.getByText("Page 1 of 2")).toBeVisible();
    await expect(page.getByRole("button", { name: "Page 2", exact: true })).toBeHidden();
    for (const button of [previous(page), next(page)]) {
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await next(page).scrollIntoViewIfNeeded();
    await next(page).click();
    await expect(summary(page, "Showing 26–30 of 30 orders")).toBeVisible();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();

    // The page-size dropdown works by touch size, and nothing sticks out sideways
    await chooseOption(page, "Rows per page for orders", "10");
    await expect(summary(page, "Showing 1–10 of 30 orders")).toBeVisible();
    const extra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(extra).toBeLessThanOrEqual(0);
  });
});

test.describe("quality and resources lists", () => {
  test("are paged by the server too", async ({ page, request }) => {
    // 12 orders reach quality inspection
    const orders = [];
    for (let i = 0; i < 12; i++) {
      const order = await createOrderViaApi(request, { quantity: 1 });
      await runStepsViaApi(request, order.id, ["design_review", "printing", "post_processing"]);
      orders.push(order);
    }

    await page.goto("/quality");
    const pending = page.getByRole("navigation", { name: "Awaiting inspection pages" });
    await expect(pending.getByText(/Showing 1–10 of \d+ orders/)).toBeVisible();
    await pending.getByRole("button", { name: "Next" }).click();
    await expect(pending.getByText(/Showing 11–\d+ of \d+ orders/)).toBeVisible();

    // Passing them all: the history grows, they move to "Ready for release", and nothing is lost
    for (const order of orders) {
      const recorded = await request.post(`${API}/api/orders/${order.id}/inspections`, { data: { result: "pass", notes: "ok" } });
      expect(recorded.status()).toBe(201);
    }
    const history = page.getByRole("navigation", { name: "Inspection records pages" });
    await expect(history.getByText(/Showing 1–10 of \d+ inspections/)).toBeVisible();
    await history.getByRole("button", { name: "Next" }).click();
    await expect(history.getByText(/Showing 11–\d+ of \d+ inspections/)).toBeVisible();
    const ready = page.getByRole("navigation", { name: "Ready for release pages" });
    await expect(ready.getByText(/Showing 1–10 of \d+ orders/)).toBeVisible();

    // The usage history has at least those 12 print jobs
    await page.goto("/resources");
    await chooseOption(page, "Rows per page for usage records", "10");
    const usage = page.getByRole("navigation", { name: "usage records pages" });
    await expect(usage.getByText(/Showing 1–10 of \d+ usage records/)).toBeVisible();
    await usage.getByRole("button", { name: "Next" }).click();
    await expect(usage.getByText(/Showing 11–\d+ of \d+ usage records/)).toBeVisible();
  });
});
