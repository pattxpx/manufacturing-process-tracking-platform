import { test as base, expect, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";

type Playwright = PlaywrightWorkerArgs["playwright"];

export const API = "http://localhost:8100";

/** A direct connection to the backend, signed in as the test administrator (with its own session and CSRF token). */
export async function adminRequest(playwright: Playwright): Promise<APIRequestContext> {
  // An empty cookie jar on purpose: signing in while holding another session's cookie would end that session
  const anonymous = await playwright.request.newContext({ baseURL: API, storageState: { cookies: [], origins: [] } });
  const response = await anonymous.post("/api/auth/login", {
    data: { username: process.env.E2E_ADMIN_USERNAME, password: process.env.E2E_ADMIN_PASSWORD },
  });
  if (!response.ok()) throw new Error(`Test API sign-in failed: HTTP ${response.status()}`);
  const { csrf_token } = await response.json();
  const state = await anonymous.storageState();
  await anonymous.dispose();
  return playwright.request.newContext({ baseURL: API, storageState: state, extraHTTPHeaders: { "X-CSRF-Token": csrf_token } });
}

// Tests call the backend API directly for set-up. The `request` fixture is replaced by a signed-in one.
export const test = base.extend<{ request: APIRequestContext }, { adminApi: APIRequestContext }>({
  adminApi: [async ({ playwright }, use) => {
    const context = await adminRequest(playwright);
    await use(context);
    await context.dispose();
  }, { scope: "worker" }],
  request: async ({ adminApi }, use) => {
    await use(adminApi);
  },
});

export { expect };
