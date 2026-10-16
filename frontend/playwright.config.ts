import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

// The E2E run uses its own backend (port 8100), database (mfg_e2e) and frontend (port 3100),
// so it never touches the demo data. The database is reset every time the run starts.
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql+psycopg://localhost:5432/mfg_e2e";

// A random administrator password for this run only. It is created with the same command an operator uses
// (python -m app.manage create-admin), so no password is stored anywhere in the repository.
process.env.E2E_ADMIN_USERNAME ??= "e2e-admin";
process.env.E2E_ADMIN_PASSWORD ??= randomBytes(24).toString("base64url");

export default defineConfig({
  testDir: "./e2e",
  workers: 1, // tests share one database and the print queue is FIFO, so they run one at a time
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    storageState: "e2e/.auth/admin.json", // every browser starts signed in (created by global-setup.ts)
  },
  webServer: [
    {
      command:
        "../backend/.venv/bin/alembic upgrade head && ../backend/.venv/bin/python -m app.seed --empty --yes && " +
        // The test database keeps its accounts between runs, so: create the admin, or if it exists, give it this run's password
        "(../backend/.venv/bin/python -m app.manage create-admin --username \"$E2E_ADMIN_USERNAME\" --full-name 'E2E Admin' || " +
        "../backend/.venv/bin/python -m app.manage reset-password --username \"$E2E_ADMIN_USERNAME\") && " +
        "../backend/.venv/bin/uvicorn app.main:app --port 8100",
      cwd: "../backend",
      url: "http://localhost:8100/api/health",
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        ALLOWED_ORIGINS: "http://localhost:3100",
        ALLOWED_HOSTS: "localhost,127.0.0.1",
        APP_TIMEZONE: "Asia/Bangkok",
        API_RATE_LIMIT_PER_MINUTE: "100000", // the test suite makes thousands of requests from one address
        INITIAL_ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD!,
        E2E_ADMIN_USERNAME: process.env.E2E_ADMIN_USERNAME!,
      },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 60_000,
    },
    {
      command: "npm run dev -- --port 3100",
      url: "http://localhost:3100/login",
      env: {
        BACKEND_URL: "http://localhost:8100",
        NEXT_PUBLIC_WS_URL: "ws://localhost:8100/ws/production/",
        NEXT_DIST_DIR: ".next-e2e",
      },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 60_000,
    },
  ],
});
