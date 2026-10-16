import AxeBuilder from "@axe-core/playwright";
import { adminRequest, expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { API, createOrderViaApi, runStepsViaApi } from "./helpers";

// Automated accessibility audit with axe-core (WCAG 2.0/2.1 A and AA rules plus axe best practices).
// This finds many problems but not all of them: it cannot judge reading order, meaningful link text,
// or how a screen reader really sounds, so it is not a claim of full compliance.
// It runs last because it creates the jobs that its dialogs need.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * While a dropdown menu is open, Radix marks the rest of the page aria-hidden and traps keyboard focus inside
 * the menu (so the hidden sidebar and header links cannot be reached), and the menu itself is a portal that
 * sits outside the page landmarks. axe reports those three facts as violations, but they are properties of the
 * modal-overlay pattern and not barriers for users. For scans taken with a menu open, only these rules are
 * switched off. Every other rule (contrast, names, roles, ...) still runs.
 */
const OVERLAY_RULES = ["aria-hidden-focus", "region", "page-has-heading-one"];

async function expectNoViolations(page: Page, where: string, options: { menuOpen?: boolean } = {}) {
  const audit = new AxeBuilder({ page }).withTags(TAGS);
  if (options.menuOpen) audit.disableRules(OVERLAY_RULES);
  const results = await audit.analyze();
  const report = results.violations.map(
    (violation) =>
      `[${violation.impact}] ${violation.id}: ${violation.help}\n` +
      violation.nodes.slice(0, 3).map((node) => `    ${node.target.join(" ")}\n    ${node.failureSummary?.split("\n").slice(1).join(" ")}`).join("\n"),
  );
  expect(report, `accessibility violations on: ${where}`).toEqual([]);
}

let runningJob = { id: 0, order_number: "" };
let waitingJob = { id: 0, order_number: "" };
let inspectJob = { id: 0, order_number: "" };
let releaseJob = { id: 0, order_number: "" };
let failedJob = { id: 0, order_number: "" };

test.beforeAll(async ({ playwright }) => {
  const request = await adminRequest(playwright);
  const record = (id: number, result: string, notes: string) =>
    request.post(`${API}/api/orders/${id}/inspections`, { data: { result, notes } });

  inspectJob = await createOrderViaApi(request, { product: "Hearing Aid Shell", quantity: 2 });
  await runStepsViaApi(request, inspectJob.id, ["design_review", "printing", "post_processing"]);

  releaseJob = await createOrderViaApi(request, { product: "Hearing Aid Shell", quantity: 2 });
  await runStepsViaApi(request, releaseJob.id, ["design_review", "printing", "post_processing"]);
  await record(releaseJob.id, "pass", "Fit check OK");

  failedJob = await createOrderViaApi(request, { product: "Hearing Aid Shell", quantity: 2 });
  await runStepsViaApi(request, failedJob.id, ["design_review", "printing", "post_processing"]);
  await record(failedJob.id, "fail", "Surface porosity on the rim");

  runningJob = await createOrderViaApi(request, { product: "Custom Surgical Guide", quantity: 2 });
  await runStepsViaApi(request, runningJob.id, ["design_review"]);
  await request.post(`${API}/api/orders/${runningJob.id}/steps/printing/start`, { data: {} });

  waitingJob = await createOrderViaApi(request, { product: "Custom Surgical Guide", quantity: 2 });
  await runStepsViaApi(request, waitingJob.id, ["design_review"]);
  await request.dispose();
});

test.describe("pages", () => {
  for (const [name, path] of [
    ["dashboard", "/"],
    ["orders list", "/orders"],
    ["new order form", "/orders/new"],
    ["production board", "/production"],
    ["resources", "/resources"],
    ["quality and release", "/quality"],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      await expectNoViolations(page, name);
    });
  }

  test("order details, and the edit form of a locked order", async ({ page }) => {
    await page.goto(`/orders/${runningJob.id}`);
    await expect(page.getByRole("heading", { name: runningJob.order_number })).toBeVisible();
    await expect(page.getByRole("row", { name: /Medical Photopolymer Resin/ })).toBeVisible();
    await expectNoViolations(page, "order details");
    await page.getByRole("button", { name: "Edit" }).click();
    await expectNoViolations(page, "locked order edit form");
  });

  test("order details of a failed order (release blocked)", async ({ page }) => {
    await page.goto(`/orders/${failedJob.id}`);
    await expect(page.getByText("Release is blocked")).toBeVisible();
    await expectNoViolations(page, "order with blocked release");
  });

  test("form with validation errors", async ({ page }) => {
    await page.goto("/orders/new");
    await page.getByRole("button", { name: "Create order" }).click();
    await expect(page.getByText("Enter how many units to make.")).toBeVisible();
    await expectNoViolations(page, "new order form with errors");
  });

  test("orders list with a search that finds nothing", async ({ page }) => {
    await page.goto("/orders");
    await page.getByLabel("Search orders").fill("zzz-nothing");
    await expect(page.getByText("No orders match your filters")).toBeVisible();
    await expectNoViolations(page, "empty search result");
  });
});

test.describe("dropdowns and dialogs", () => {
  test("an open dropdown", async ({ page }) => {
    await page.goto("/orders");
    await page.getByRole("combobox", { name: "Filter by status" }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expectNoViolations(page, "open filter dropdown", { menuOpen: true });
  });

  test("the rows-per-page dropdown", async ({ page }) => {
    await page.goto("/orders");
    await page.getByRole("combobox", { name: "Rows per page for orders" }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expectNoViolations(page, "open rows-per-page dropdown", { menuOpen: true });
  });

  test("start printing, with the printer dropdown open", async ({ page }) => {
    await page.goto("/production");
    await page.getByRole("button", { name: `Start 3D Printing for ${waitingJob.order_number}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Materials to reserve")).toBeVisible();
    await expectNoViolations(page, "start printing dialog");
    await dialog.getByRole("combobox", { name: "Printer" }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expectNoViolations(page, "start printing dialog with printer dropdown open", { menuOpen: true });
  });

  test("complete printing", async ({ page }) => {
    await page.goto("/production");
    await page.getByRole("button", { name: `Complete 3D Printing for ${runningJob.order_number}` }).click();
    await expect(page.getByLabel("Isopropyl Alcohol used (ml)")).toBeVisible();
    await expectNoViolations(page, "complete printing dialog");
    await page.getByLabel("Isopropyl Alcohol used (ml)").fill("999");
    await page.getByRole("button", { name: "Complete printing" }).click();
    await expect(page.getByText(/Cannot be more than the reserved/)).toBeVisible();
    await expectNoViolations(page, "complete printing dialog with an error");
  });

  test("inspection, with a validation error", async ({ page }) => {
    await page.goto("/quality");
    await page.getByRole("button", { name: `Inspect ${inspectJob.order_number}` }).click();
    await expectNoViolations(page, "inspection dialog");
    await page.getByLabel("Fail").check();
    await page.getByRole("button", { name: "Record fail" }).click();
    await expect(page.getByText("Notes are required when an inspection fails")).toBeVisible();
    await expectNoViolations(page, "inspection dialog with an error");
  });

  test("release confirmation", async ({ page }) => {
    await page.goto("/quality");
    await page.getByRole("button", { name: `Release ${releaseJob.order_number}` }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Release order" })).toBeVisible();
    await expectNoViolations(page, "release confirmation dialog");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("menu and key pages", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("button", { name: "Close navigation menu" })).toBeVisible();
    await expectNoViolations(page, "mobile navigation menu");
    await page.keyboard.press("Escape");

    for (const path of ["/orders", "/production", "/resources", "/quality"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      await expectNoViolations(page, `${path} on a phone`);
    }
  });
});

test.describe("sign-in, management and scheduling screens", () => {
  for (const [name, path] of [
    ["schedule", "/schedule"], ["users", "/users"], ["audit log", "/audit"], ["account", "/account"],
  ] as const) {
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      await expectNoViolations(page, name);
    });
  }

  test("the plan dialog, with an error", async ({ page }) => {
    await page.goto(`/orders/${waitingJob.id}`);
    await page.getByRole("button", { name: "Plan print" }).click();
    const dialog = page.getByRole("dialog");
    await expectNoViolations(page, "plan dialog");
    await dialog.getByLabel("Estimated duration (minutes)").fill("0");
    await dialog.getByRole("button", { name: "Save plan" }).click();
    await expect(dialog.getByText(/whole minutes/)).toBeVisible();
    await expectNoViolations(page, "plan dialog with a validation error");
  });

  test("the add-user dialog, with a server error", async ({ page }) => {
    await page.goto("/users");
    await page.getByRole("button", { name: "Add user" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("User name").fill("someone-new");
    await dialog.getByLabel("Full name").fill("Some One");
    await dialog.getByLabel("Temporary password").fill("short");
    await dialog.getByRole("button", { name: "Create user" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expectNoViolations(page, "add user dialog with an error");
  });

  test("the resource dialogs: add, edit, adjust and history", async ({ page }) => {
    await page.goto("/resources");
    await page.getByRole("button", { name: "Add material" }).click();
    await expectNoViolations(page, "add material dialog");
    await page.keyboard.press("Escape");

    const row = page.getByRole("row").filter({ hasText: "Argon Gas" }).first();
    await row.getByRole("button", { name: "Edit Argon Gas" }).click();
    await expectNoViolations(page, "edit material dialog");
    await page.keyboard.press("Escape");

    await row.getByRole("button", { name: "Adjust stock of Argon Gas" }).click();
    await page.getByRole("dialog").getByLabel(/Quantity/).fill("5");
    await page.getByRole("dialog").getByRole("button", { name: "Record adjustment" }).click();
    await expect(page.getByRole("dialog").getByText("Give a reason")).toBeVisible();
    await expectNoViolations(page, "adjust stock dialog with an error");
    await page.keyboard.press("Escape");

    await row.getByRole("button", { name: "Stock history of Argon Gas" }).click();
    await expect(page.getByRole("dialog").getByText(/No adjustments yet|Showing/)).toBeVisible();
    await expectNoViolations(page, "stock history dialog");
  });

  test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("the sign-in page, also with an error", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
      await expectNoViolations(page, "sign-in page");
      await page.getByLabel("User name").fill("nobody-here");
      await page.getByLabel("Password").fill("not-a-password-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
      await expectNoViolations(page, "sign-in page with an error");
    });
  });
});
