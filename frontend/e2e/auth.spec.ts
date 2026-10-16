import { expect, test } from "./fixtures";
import { API } from "./helpers";

// Signing in and out, sessions, cookies, CSRF, the WebSocket, security headers, and managing users.
// These tests start signed OUT (and sign in with their own sessions) so they never end the shared test session.

const SIGNED_OUT = { cookies: [], origins: [] };
const adminName = () => process.env.E2E_ADMIN_USERNAME!;
const adminPassword = () => process.env.E2E_ADMIN_PASSWORD!;

async function signIn(page: import("@playwright/test").Page, username = adminName(), password = adminPassword()) {
  await page.getByLabel("User name").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT });

  test("protected pages send you to sign in, and back again afterwards", async ({ page }) => {
    await page.goto("/orders");
    await expect(page).toHaveURL(/\/login\?next=%2Forders/);
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();

    await signIn(page);
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible();
    await expect(page.getByText(adminName(), { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Live updates on")).toBeVisible(); // the WebSocket is open with its ticket
  });

  test("wrong credentials give one generic message and keep the user name", async ({ page }) => {
    await page.goto("/login");
    await signIn(page, adminName(), "this-is-not-the-password");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Invalid username or password.");
    await expect(page.getByLabel("User name")).toHaveValue(adminName());
    await expect(page.getByLabel("Password")).toHaveValue(""); // the password is cleared

    await page.getByLabel("User name").fill("nobody-at-all");
    await signIn(page, "nobody-at-all", "this-is-not-the-password");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Invalid username or password."); // the same words
  });

  test("repeated wrong passwords are slowed down", async ({ page }) => {
    const attacker = `intruder-${Date.now().toString().slice(-6)}`; // not the real admin, so the other tests are unaffected
    await page.goto("/login");
    for (let attempt = 0; attempt < 5; attempt++) {
      await signIn(page, attacker, "wrong-password-123");
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Invalid username or password.");
    }
    await signIn(page, attacker, "wrong-password-123");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Too many failed sign-in attempts");
  });

  test("the sign-in page does not redirect to other websites", async ({ page }) => {
    await page.goto("/login?next=//evil.example/path");
    await signIn(page);
    await expect(page).toHaveURL("http://localhost:3100/");
  });

  test("API calls without a session are refused, and no cookie is set for a failed login", async ({ page }) => {
    const refused = await page.request.get("/api/orders");
    expect(refused.status()).toBe(401);
    const failed = await page.request.post("/api/auth/login", { data: { username: "x", password: "y" } });
    expect(failed.status()).toBe(401);
    expect(failed.headers()["set-cookie"]).toBeUndefined();
  });
});

test.describe("signed in", () => {
  test.use({ storageState: SIGNED_OUT });

  test("the session cookie is HttpOnly and nothing secret is kept in browser storage", async ({ page, context }) => {
    await page.goto("/login");
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

    const cookie = (await context.cookies()).find((c) => c.name === "session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.path).toBe("/");

    const exposed = await page.evaluate(() => ({
      cookies: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }),
    }));
    expect(exposed.cookies).not.toContain("session");  // scripts cannot read the session cookie
    expect(exposed.local + exposed.session).not.toMatch(/csrf|token|session|password/i);
  });

  test("signing out ends the session on the server, not only in the browser", async ({ page, context }) => {
    await page.goto("/login");
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    const stolenCookie = (await context.cookies()).find((c) => c.name === "session")!;

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/orders");
    await expect(page).toHaveURL(/\/login/);

    // Someone who copied the cookie before sign-out gets nothing with it
    const replay = await page.context().request.get("/api/orders", { headers: { Cookie: `session=${stolenCookie.value}` } });
    expect(replay.status()).toBe(401);
  });

  test("when the session ends while working, you are sent to sign in with an explanation", async ({ page }) => {
    await page.goto("/login");
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await page.route("**/api/orders?*", (route) => route.fulfill({ status: 401, json: { detail: "Not authenticated" } }));
    await page.getByRole("link", { name: "Orders", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Forders&expired=1/);
    await expect(page.getByText("Your session ended. Please sign in again.")).toBeVisible();
  });

  test("a request without the CSRF token, or from another website, is refused", async ({ page }) => {
    await page.goto("/login");
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    const body = { product: "Hearing Aid Shell", quantity: 1, design_reference: "CSRF-TEST" };

    // The browser's cookie is sent automatically, which is exactly what an attacker's page would rely on
    const noToken = await page.request.post("/api/orders", { data: body });
    expect(noToken.status()).toBe(403);
    const crossSite = await page.request.post("/api/orders", { data: body, headers: { Origin: "https://evil.example" } });
    expect(crossSite.status()).toBe(403);
  });

  test("the live-updates socket refuses anyone without a valid ticket", async ({ page }) => {
    await page.goto("/login");
    await signIn(page);
    await expect(page.getByText("Live updates on")).toBeVisible();
    const outcomes = await page.evaluate(async () => {
      const url = "ws://localhost:8100/ws/production/";
      const attempt = (protocols?: string[]) => new Promise<string>((resolve) => {
        const socket = new WebSocket(url, protocols);
        socket.onopen = () => { socket.close(); resolve("OPENED"); };
        socket.onerror = () => resolve("refused");
        socket.onclose = () => resolve("refused");
      });
      return { none: await attempt(), fake: await attempt(["mfg-v1", "ticket.not-a-real-ticket"]) };
    });
    expect(outcomes).toEqual({ none: "refused", fake: "refused" });
  });

  test("the website sends security headers, and its scripts need a one-time nonce", async ({ page }) => {
    const response = await page.goto("/login");
    const headers = response!.headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBeTruthy();
    expect(headers["x-powered-by"]).toBeUndefined();
    const csp = headers["content-security-policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain("'unsafe-inline'");

    const second = (await (await page.request.get("/login")).headers())["content-security-policy"];
    expect(second.match(/nonce-[^']+/)![0]).not.toBe(csp.match(/nonce-[^']+/)![0]); // a fresh nonce per request

    const api = await page.request.get("/api/auth/me");
    expect(api.headers()["cache-control"]).toBe("no-store");
  });

  test("the page works under the content security policy (no violations)", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => /content security policy|Refused to/i.test(message.text()) && violations.push(message.text()));
    await page.goto("/login");
    await signIn(page);
    for (const link of ["Orders", "Production Board", "Schedule", "Resources", "Quality & Release"]) {
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    expect(violations).toEqual([]);
  });
});

test.describe("administering users", () => {
  test("an administrator creates an account, who can sign in and is an admin; deactivating ends their session", async ({ page, browser }) => {
    const username = `helper-${Date.now().toString().slice(-6)}`;
    const password = "a-long-helper-password-1";
    await page.goto("/users");
    await expect(page.getByText("Everyone is an administrator for now")).toBeVisible();

    await page.getByRole("button", { name: "Add user" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("User name").fill(username);
    await dialog.getByLabel("Full name").fill("Helper Person");
    await dialog.getByLabel("Temporary password").fill("short");
    await dialog.getByRole("button", { name: "Create user" }).click();
    await expect(dialog.getByRole("alert")).toContainText("at least 12 characters");   // refused by the server, form kept
    await expect(dialog.getByLabel("User name")).toHaveValue(username);
    await dialog.getByLabel("Temporary password").fill(password);
    await expect(dialog.getByRole("combobox", { name: "Role" })).toContainText("admin"); // the default role
    await dialog.getByRole("button", { name: "Create user" }).click();
    await expect(page.getByText(`User ${username} created`)).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: username })).toContainText("Active");

    // The new person signs in on their own device and has full access
    const other = await browser.newContext({ storageState: SIGNED_OUT });
    const otherPage = await other.newPage();
    await otherPage.goto("/login");
    await signIn(otherPage, username, password);
    await expect(otherPage.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await expect(otherPage.getByRole("link", { name: "Users" })).toBeVisible();

    // Deactivate: asks first, and their session ends at once
    await page.getByRole("button", { name: `Deactivate ${username}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByRole("row").filter({ hasText: username })).toContainText("Deactivated");
    expect((await other.request.get("/api/orders")).status()).toBe(401);
    await other.close();
  });

  test("you cannot deactivate yourself, and the audit log shows the sign-ins", async ({ page }) => {
    await page.goto("/users");
    await expect(page.getByRole("button", { name: `Deactivate ${adminName()}` })).toBeDisabled();

    await page.goto("/audit");
    await expect(page.getByRole("row").filter({ hasText: "login success" }).first()).toBeVisible();
    await page.getByRole("combobox", { name: "Filter by action" }).click();
    await page.getByRole("option", { name: "user created" }).click();
    await expect(page.getByRole("row").nth(1)).toContainText("user created");
  });

  test("changing your own password signs out other sessions", async ({ browser, request }) => {
    const username = `pw-${Date.now().toString().slice(-6)}`;
    const created = await request.post(`${API}/api/users`, { data: { username, full_name: "Pw Test", password: "an-old-long-password-1" } });
    expect(created.status()).toBe(201);

    const first = await browser.newContext({ storageState: SIGNED_OUT });
    const second = await browser.newContext({ storageState: SIGNED_OUT });
    for (const context of [first, second]) {
      const p = await context.newPage();
      await p.goto("/login");
      await signIn(p, username, "an-old-long-password-1");
      await expect(p.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    }
    const [firstPage] = first.pages();
    await firstPage.goto("/account");
    await firstPage.getByLabel("Current password").fill("an-old-long-password-1");
    await firstPage.getByLabel(/^New password/).fill("a-new-long-password-2");
    await firstPage.getByLabel("Repeat new password").fill("a-different-one-3");
    await firstPage.getByRole("button", { name: "Change password" }).click();
    await expect(firstPage.getByRole("main").getByRole("alert")).toContainText("do not match");
    await firstPage.getByLabel("Repeat new password").fill("a-new-long-password-2");
    await firstPage.getByRole("button", { name: "Change password" }).click();
    await expect(firstPage.getByText("Password changed")).toBeVisible();

    expect((await first.request.get("/api/orders")).status()).toBe(200);   // this device stays signed in
    expect((await second.request.get("/api/orders")).status()).toBe(401);  // the other one is signed out
    await first.close();
    await second.close();
  });
});
