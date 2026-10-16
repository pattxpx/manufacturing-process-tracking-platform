import { expect, test } from "./fixtures";
import { createOrderViaUi, newOrderNumber, showOnBoard } from "./helpers";

test("create and view an order", async ({ page }) => {
  const orderNumber = newOrderNumber();
  await createOrderViaUi(page, {
    orderNumber, product: "Titanium Spinal Cage", quantity: 12, designRef: "DR-SC-900-A",
  });

  // Detail page shows what was entered, plus the calculated material need (12 x 40 g)
  await expect(page.getByText("Titanium Spinal Cage").first()).toBeVisible();
  await expect(page.getByText("DR-SC-900-A")).toBeVisible();
  await expect(page.getByRole("row", { name: /Ti-6Al-4V Powder.*480 g/ })).toBeVisible();
  await expect(page.getByText("New", { exact: true })).toBeVisible();

  // And it is listed (search works)
  await page.goto("/orders");
  await page.getByLabel("Search orders").fill(orderNumber);
  await expect(page.getByRole("link", { name: orderNumber })).toBeVisible();
});

test("create form shows validation messages", async ({ page }) => {
  await page.goto("/orders/new");
  await page.getByRole("button", { name: "Create order" }).click();
  await expect(page.getByText("Choose a product from the list.")).toBeVisible();
  await expect(page.getByText("Enter how many units to make.")).toBeVisible();
  await expect(page.getByText("Enter the design reference, e.g. CAD-CIP-001-v2.1.")).toBeVisible();
  // Keyboard focus moves to the first field with a problem
  await expect(page.getByRole("combobox", { name: "Product" })).toBeFocused();
});

test("edit an order before production starts, then it is locked", async ({ page }) => {
  const orderNumber = newOrderNumber();
  await createOrderViaUi(page, {
    orderNumber, product: "Hearing Aid Shell", quantity: 5, designRef: "DR-HA-100-A",
  });

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Quantity").fill("7");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Order updated")).toBeVisible();
  await expect(page.getByRole("row", { name: /Medical Photopolymer Resin.*56 ml/ })).toBeVisible(); // 7 x 8 ml

  // Start production on the board
  await page.goto("/production");
  await showOnBoard(page, orderNumber);
  await page.getByRole("button", { name: `Start Design Review for ${orderNumber}` }).click();
  await expect(page.getByRole("button", { name: `Complete Design Review for ${orderNumber}` })).toBeVisible();

  // Production-critical fields are now locked
  await page.getByRole("link", { name: orderNumber }).first().click();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText("Production has started, so the order number")).toBeVisible();
  await expect(page.getByLabel("Quantity")).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Product" })).toBeDisabled();
  await expect(page.getByLabel("Notes (optional)")).toBeEnabled();
});
