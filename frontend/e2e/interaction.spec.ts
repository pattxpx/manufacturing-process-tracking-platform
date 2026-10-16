import { expect, test } from "./fixtures";
import type { Locator } from "@playwright/test";
import { API, createOrderViaApi, runStepsViaApi } from "./helpers";

// Mouse cursor, hover/focus states and keyboard behaviour.

const cursorOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).cursor);
const styleOf = (locator: Locator, property: string) =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

test.describe("cursor", () => {
  test.beforeEach(async ({ request }) => {
    await createOrderViaApi(request); // make sure the list has at least one row
  });

  test("clickable things show a pointer", async ({ page }) => {
    await page.goto("/orders");
    await expect(page.getByRole("row").nth(1)).toBeVisible();

    expect(await cursorOf(page.getByRole("link", { name: "New order" }))).toBe("pointer");
    expect(await cursorOf(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Resources" }))).toBe("pointer");
    expect(await cursorOf(page.getByRole("combobox", { name: "Filter by status" }))).toBe("pointer");
    expect(await cursorOf(page.getByRole("row").nth(1).getByRole("link").first())).toBe("pointer");
    expect(await cursorOf(page.getByRole("button", { name: "Page 1", exact: true }))).toBe("pointer");

    // Options inside an open dropdown
    await page.getByRole("combobox", { name: "Filter by step" }).click();
    expect(await cursorOf(page.getByRole("option", { name: "Printing" }).or(page.getByRole("option", { name: "3D Printing" })))).toBe("pointer");
    await page.keyboard.press("Escape");

    // Dashboard cards are links, so they are clickable too
    await page.goto("/");
    expect(await cursorOf(page.getByRole("link", { name: /Total orders/ }))).toBe("pointer");
  });

  test("text, cards, table rows and decorations keep the normal cursor", async ({ page }) => {
    await page.goto("/orders");
    const row = page.getByRole("row").nth(1);
    await expect(row).toBeVisible();

    expect(await cursorOf(page.getByRole("heading", { name: "Orders", level: 1 }))).not.toBe("pointer");
    expect(await cursorOf(row)).not.toBe("pointer");               // rows are not clickable
    expect(await cursorOf(row.getByRole("cell").nth(1))).not.toBe("pointer");
    expect(await cursorOf(page.getByRole("columnheader").first())).not.toBe("pointer");
    expect(await cursorOf(page.getByLabel("Search orders"))).toBe("text");

    // ...and a row does not change colour on hover, because it does nothing when clicked
    const before = await styleOf(row, "background-color");
    await row.hover();
    expect(await styleOf(row, "background-color")).toBe(before);
  });

  test("disabled controls say they are unavailable", async ({ page, request }) => {
    await page.goto("/orders");
    await expect(page.getByRole("row").nth(1)).toBeVisible();
    const previous = page.getByRole("button", { name: "Previous" }).first(); // first page: nothing before it
    await expect(previous).toBeDisabled();
    expect(await cursorOf(previous)).toBe("not-allowed");

    // A locked field: production has started on this order
    const order = await createOrderViaApi(request);
    await request.post(`${API}/api/orders/${order.id}/steps/design_review/start`, { data: {} });
    await page.goto(`/orders/${order.id}`);
    await page.getByRole("button", { name: "Edit" }).click();
    expect(await cursorOf(page.getByLabel("Quantity"))).toBe("not-allowed");
    expect(await cursorOf(page.getByRole("combobox", { name: "Product" }))).toBe("not-allowed");
    expect(await cursorOf(page.getByLabel("Notes (optional)"))).toBe("text"); // still editable
  });
});

test.describe("hover, focus and keyboard", () => {
  test("a primary button reacts to the mouse", async ({ page }) => {
    await page.goto("/orders");
    const button = page.getByRole("link", { name: "New order" });
    const resting = await styleOf(button, "background-color");
    expect(resting).toBe("rgb(0, 181, 226)"); // the brand colour #00B5E2
    await button.hover();
    await expect.poll(() => styleOf(button, "background-color")).not.toBe(resting);
  });

  test("keyboard focus is visible, and the skip link works", async ({ page }) => {
    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible(); // the session check is done
    const skip = page.getByRole("link", { name: "Skip to content" });
    // (In development Next.js adds its own dev-tools button in front, so allow a couple of Tab presses.)
    for (let presses = 0; presses < 3 && !(await skip.evaluate((el) => el === document.activeElement)); presses++) {
      await page.keyboard.press("Tab");
    }
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused(); // focus really moved to the content

    // Every kind of control gets the same visible ring (2 px, brand teal) when reached by keyboard
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    expect(await styleOf(focused, "outline-style")).toBe("solid");
    expect(await styleOf(focused, "outline-width")).toBe("2px");
    // (the colour fades in over 150 ms, so wait for the final value)
    await expect.poll(() => styleOf(focused, "outline-color")).toBe("rgb(0, 137, 172)");
  });

  test("a dropdown shows the same focus ring", async ({ page }) => {
    await page.goto("/orders");
    const status = page.getByRole("combobox", { name: "Filter by status" });
    await status.focus();
    await page.keyboard.press("Shift+Tab"); // move away and back by keyboard so :focus-visible applies
    await page.keyboard.press("Tab");
    await expect(status).toBeFocused();
    expect(await styleOf(status, "outline-style")).toBe("solid");
    await expect.poll(() => styleOf(status, "outline-color")).toBe("rgb(0, 137, 172)");
  });
});

test.describe("dialog focus management", () => {
  test("focus moves into the dialog, stays inside, and returns when it closes", async ({ page, request }) => {
    const order = await createOrderViaApi(request, { quantity: 1 });
    await runStepsViaApi(request, order.id, ["design_review", "printing", "post_processing"]);
    await page.goto("/quality");

    const trigger = page.getByRole("button", { name: `Inspect ${order.order_number}` });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const insideDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    expect(await insideDialog()).toBe(true);

    // Tab and Shift+Tab never leave the dialog
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await insideDialog()).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await insideDialog()).toBe(true);
    }

    // The close icon has a name and a tooltip
    const close = dialog.getByRole("button", { name: "Close dialog" });
    await expect(close).toHaveAttribute("title", "Close");
    expect(await cursorOf(close)).toBe("pointer");

    // Validation moves focus to the field that needs attention
    await dialog.getByLabel("Fail").check();
    await dialog.getByRole("button", { name: "Record fail" }).click();
    await expect(dialog.getByText("Notes are required when an inspection fails")).toBeVisible();
    await expect(dialog.getByLabel("Inspection notes")).toBeFocused();
    await expect(dialog.getByLabel("Inspection notes")).toHaveAttribute("aria-invalid", "true");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused(); // back where the user was
  });

  test("the phone menu is a dialog too, with named icon buttons", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const open = page.getByRole("button", { name: "Open navigation menu" });
    await expect(open).toHaveAttribute("title", "Open navigation menu");
    expect(await cursorOf(open)).toBe("pointer");
    await open.click();
    const close = page.getByRole("button", { name: "Close navigation menu" });
    await expect(close).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(close).toBeHidden();
    await expect(open).toBeFocused();
  });
});
