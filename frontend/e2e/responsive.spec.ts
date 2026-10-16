import { adminRequest, expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { API, chooseOption, createOrderViaApi, runStepsViaApi } from "./helpers";

// Layout checks at four screen sizes: no sideways page scroll, no console errors,
// dialogs and dropdown menus stay inside the screen. Runs last, so it can leave a job running.

const viewports = [
  { name: "desktop 1440", width: 1440, height: 900 },
  { name: "laptop 1024", width: 1024, height: 768 },
  { name: "tablet 768", width: 768, height: 1024 },
  { name: "mobile 375", width: 375, height: 812 },
];

let newOrderId = 0;
let runningOrder = { id: 0, order_number: "" };
let qcOrder = { id: 0, order_number: "" };

test.beforeAll(async ({ playwright }) => {
  const request = await adminRequest(playwright);
  const inspect = (id: number, result: string, notes: string) =>
    request.post(`${API}/api/orders/${id}/inspections`, { data: { result, notes } });

  newOrderId = (await createOrderViaApi(request, { product: "Titanium Spinal Cage", quantity: 12 })).id;

  qcOrder = await createOrderViaApi(request, { product: "Custom Surgical Guide", quantity: 2 });
  await runStepsViaApi(request, qcOrder.id, ["design_review", "printing", "post_processing"]);

  const failed = await createOrderViaApi(request, { product: "Hearing Aid Shell", quantity: 3 });
  await runStepsViaApi(request, failed.id, ["design_review", "printing", "post_processing"]);
  await inspect(failed.id, "fail", "Surface porosity on the rim, needs another polishing pass");

  const passed = await createOrderViaApi(request, { product: "Hearing Aid Shell", quantity: 3 });
  await runStepsViaApi(request, passed.id, ["design_review", "printing", "post_processing"]);
  await inspect(passed.id, "pass", "Fit check OK");

  const blocked = await createOrderViaApi(request, { product: "Cranial Implant Plate", quantity: 1000 });
  await runStepsViaApi(request, blocked.id, ["design_review"]); // waits in the print queue, blocked by material

  runningOrder = await createOrderViaApi(request, { product: "Custom Surgical Guide", quantity: 2 });
  await runStepsViaApi(request, runningOrder.id, ["design_review"]);
  await request.post(`${API}/api/orders/${runningOrder.id}/steps/printing/start`, { data: {} });
  await request.dispose();
});

async function ready(page: Page) {
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function expectNoSidewaysScroll(page: Page) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(extra, "the page is wider than the screen").toBeLessThanOrEqual(0);
}

async function expectInsideViewport(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  const size = page.viewportSize()!;
  expect(box, `${selector} is not visible`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 0.5);
}

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("every page fits the screen without console errors", async ({ page }) => {
      const problems: string[] = [];
      page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
      page.on("pageerror", (error) => problems.push(error.message));

      for (const path of ["/", "/orders", "/orders/new", `/orders/${newOrderId}`, `/orders/${qcOrder.id}`, "/production", "/schedule", "/resources", "/quality", "/users", "/audit", "/account"]) {
        await page.goto(path);
        await ready(page);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectNoSidewaysScroll(page);
      }
      expect(problems).toEqual([]);
    });

    test("navigation is usable", async ({ page }) => {
      await page.goto("/");
      const compact = viewport.width < 1024; // the sidebar becomes a menu button
      if (compact) {
        await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
        await page.getByRole("button", { name: "Open navigation menu" }).click();
      }
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Resources" }).click();
      await expect(page.getByRole("heading", { name: "Resources", level: 1 })).toBeVisible();
      if (compact) await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden(); // menu closed itself
    });

    test("the multi-material completion dialog fits and scrolls", async ({ page }) => {
      await page.goto("/production");
      await ready(page);
      if (viewport.width < 768) await page.getByRole("button", { name: /3D Printing/ }).click(); // phones: pick the step
      await page.getByRole("button", { name: `Complete 3D Printing for ${runningOrder.order_number}` }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Medical Photopolymer Resin used (ml)")).toBeVisible();
      await expect(dialog.getByLabel("Isopropyl Alcohol used (ml)")).toBeVisible();
      await expectInsideViewport(page, '[role="dialog"]');
      await expectNoSidewaysScroll(page);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    test("the inspection dialog fits", async ({ page }) => {
      await page.goto("/quality");
      await ready(page);
      await page.getByRole("button", { name: `Inspect ${qcOrder.order_number}` }).click();
      await page.getByLabel("Fail").check();
      await expectInsideViewport(page, '[role="dialog"]');
      // Both the Pass and Fail choices are comfortable touch targets
      for (const name of ["Pass", "Fail"]) {
        const box = await page.getByRole("dialog").locator("label", { hasText: name }).first().boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await page.getByRole("button", { name: "Cancel" }).click();
    });

    test("a dropdown menu opens fully inside the screen", async ({ page }) => {
      await page.goto("/orders");
      await ready(page);
      await page.getByRole("combobox", { name: "Filter by step" }).click();
      await expectInsideViewport(page, '[role="listbox"]');
      await page.keyboard.press("Escape");
    });
  });
}

test.describe("production board on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("shows one step at a time, with a step switcher", async ({ page }) => {
    await page.goto("/production");
    await ready(page);
    const printing = page.getByRole("region", { name: "3D Printing" });
    const design = page.getByRole("region", { name: "Design Review" });
    await expect(design).toBeVisible();
    await expect(printing).toBeHidden();

    await page.getByRole("button", { name: /3D Printing/ }).click();
    await expect(printing).toBeVisible();
    await expect(design).toBeHidden();
    // The blocked order explains itself, and its Start button is disabled
    await expect(printing.getByText("Blocked, cannot start yet").first()).toBeVisible();
    await expect(printing.getByRole("button", { name: /^Start 3D Printing for/ }).first()).toBeDisabled();
    await expectNoSidewaysScroll(page);
  });

  test("tables become readable cards", async ({ page }) => {
    await page.goto("/orders");
    await ready(page);
    const row = page.getByRole("row").filter({ hasText: qcOrder.order_number });
    await expect(row).toContainText("Custom Surgical Guide");
    await expectNoSidewaysScroll(page);
  });
});

test("release-blocked reasons are explicit on the quality page", async ({ page }) => {
  await page.goto("/quality");
  await ready(page);
  const failedRow = page.getByRole("row").filter({ hasText: "QC failed" }).first();
  await expect(failedRow).toContainText("Release blocked");
  await expect(failedRow).toContainText("The latest inspection failed");
  const passedRow = page.getByRole("row").filter({ hasText: "Eligible" }).first();
  await expect(passedRow.getByRole("button", { name: /^Release / })).toBeEnabled();
});

test("resources page flags the material shortage and who is waiting", async ({ page }) => {
  await page.goto("/resources");
  await ready(page);
  const titanium = page.getByRole("row").filter({ hasText: "Ti-6Al-4V Powder" }).first();
  // Earlier tests also leave blocked orders in the queue, so there may be several
  await expect(titanium).toContainText(/Short for \d+ waiting orders?/);
  const argon = page.getByRole("row").filter({ hasText: "Argon Gas" }).first();
  await expect(argon).toContainText(/Short for \d+ waiting orders?/);
  await chooseOption(page, "Filter by material", "Isopropyl Alcohol");
  await expect(page.getByRole("table", { name: "Material usage history" }).getByRole("row").nth(1)).toContainText("Isopropyl Alcohol");
});

test.afterAll(async ({ playwright }) => {
  // Finish the job that was left running
  const request = await adminRequest(playwright);
  await request.post(`${API}/api/orders/${runningOrder.id}/steps/printing/complete`, { data: {} });
  await request.dispose();
});
