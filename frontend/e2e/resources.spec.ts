import { expect, test } from "./fixtures";
import { API, chooseOption } from "./helpers";

// Resource management: create, edit, deactivate, and controlled stock adjustments with a permanent history.

const name = () => `Test Compound ${Date.now().toString().slice(-6)}`;

test("add a material with opening stock, adjust it, and see the full history", async ({ page }) => {
  const material = name();
  await page.goto("/resources");
  await page.getByRole("button", { name: "Add material" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(material);
  await chooseOption(page, "Category", "Resin");
  await chooseOption(page, "Unit", "ml");
  await dialog.getByLabel(/Minimum stock/).fill("300");
  await dialog.getByLabel(/Opening stock/).fill("1000");
  await dialog.getByRole("button", { name: "Add material" }).click();
  await expect(page.getByText(`Material ${material} added`)).toBeVisible();

  const row = page.getByRole("table", { name: "Material stock" }).getByRole("row").filter({ hasText: material });
  await expect(row).toContainText("1,000 ml");
  await expect(row).toContainText("resin · measured in ml · minimum 300 ml");

  // Add stock, with a reason. The dialog previews the result.
  await row.getByRole("button", { name: `Adjust stock of ${material}` }).click();
  const adjust = page.getByRole("dialog");
  await adjust.getByLabel(/Quantity/).fill("250");
  await expect(adjust.getByText(/from 1,000 ml to 1,250 ml/)).toBeVisible();
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(adjust.getByText("Give a reason")).toBeVisible();
  await adjust.getByLabel("Reason").fill("Delivery note 4711");
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(page.getByText(`Added 250 ml to ${material}`)).toBeVisible();
  await expect(row).toContainText("1,250 ml");

  // Remove stock until it is below the minimum: the low-stock warning appears
  await row.getByRole("button", { name: `Adjust stock of ${material}` }).click();
  await chooseOption(page, "Action", "Remove stock");
  await page.getByRole("dialog").getByLabel(/Quantity/).fill("1000");
  await page.getByRole("dialog").getByLabel("Reason").fill("Spilled");
  await page.getByRole("dialog").getByRole("button", { name: "Record adjustment" }).click();
  await expect(row).toContainText("Low stock");
  await expect(row).toContainText("250 ml");

  // The history keeps every entry, with who did it
  await row.getByRole("button", { name: `Stock history of ${material}` }).click();
  const history = page.getByRole("dialog");
  const entries = history.getByRole("table").getByRole("row");
  await expect(entries).toHaveCount(4); // header + 3 entries
  await expect(entries.nth(1)).toContainText("Spilled");
  await expect(entries.nth(1)).toContainText("−1,000 ml");
  await expect(entries.nth(2)).toContainText("Delivery note 4711");
  await expect(entries.nth(3)).toContainText("Initial stock");
  await expect(entries.nth(1)).toContainText(process.env.E2E_ADMIN_USERNAME!);
});

test("removing more than is available is refused before and after the server sees it", async ({ page, request }) => {
  const material = name();
  const created = await request.post(`${API}/api/resources`, { data: { name: material, unit: "g", category: "powder", initial_stock: 100 } });
  expect(created.status()).toBe(201);
  await page.goto("/resources");
  const row = page.getByRole("table", { name: "Material stock" }).getByRole("row").filter({ hasText: material });
  await row.getByRole("button", { name: `Adjust stock of ${material}` }).click();
  await chooseOption(page, "Action", "Remove stock");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Quantity/).fill("101");
  await dialog.getByLabel("Reason").fill("Too much");
  await dialog.getByRole("button", { name: "Record adjustment" }).click();
  await expect(dialog.getByText("Only 100 g is available to remove")).toBeVisible();
  // The server says no as well (a direct call, bypassing the screen)
  const direct = await request.post(`${API}/api/resources/${(await created.json()).id}/adjustments`, { data: { quantity_change: -101, reason: "Too much" } });
  expect(direct.status()).toBe(409);
});

test("edit details, deactivate, and the unit is protected once there is history", async ({ page, request }) => {
  const material = name();
  const created = await (await request.post(`${API}/api/resources`, { data: { name: material, unit: "g", initial_stock: 50 } })).json();
  await page.goto("/resources");
  const row = page.getByRole("table", { name: "Material stock" }).getByRole("row").filter({ hasText: material });

  await row.getByRole("button", { name: `Edit ${material}` }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("To change how much is in stock, use Adjust stock");
  await expect(dialog.getByLabel(/quantity|on hand|stock level/i)).toHaveCount(0); // there is no field for quantities
  await chooseOption(page, "Unit", "kg");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("unit cannot be changed"); // it has stock history

  await chooseOption(page, "Unit", /^g$/);
  await chooseOption(page, "Status", "Inactive");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(`${material} updated`)).toBeVisible();
  await expect(row).toContainText("Inactive");

  const stored = await (await request.get(`${API}/api/resources`)).json();
  expect(stored.find((r: { id: number }) => r.id === created.id).is_active).toBe(false);
  expect((await request.delete(`${API}/api/resources/${created.id}`)).status()).toBe(405); // never deleted
  void dialog;
  dialog = page.getByRole("dialog");
});
