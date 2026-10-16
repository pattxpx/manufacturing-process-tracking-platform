import { request } from "@playwright/test";

// Signs in once and saves the cookie, so every test's browser starts signed in.
export default async function globalSetup() {
  const context = await request.newContext({ baseURL: "http://localhost:3100" });
  const response = await context.post("/api/auth/login", {
    data: { username: process.env.E2E_ADMIN_USERNAME, password: process.env.E2E_ADMIN_PASSWORD },
  });
  if (!response.ok()) throw new Error(`Test sign-in failed: HTTP ${response.status()}`);
  await context.storageState({ path: "e2e/.auth/admin.json" });
  await context.dispose();
}
