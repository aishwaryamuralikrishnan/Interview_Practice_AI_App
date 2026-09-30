import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of the UI. The model is never called: e2e/mockApi.ts answers
 * the four /api routes inside the browser, so these run with no key and no
 * network, like the Python app's fake_run.py.
 *
 * First time only:  npx playwright install chromium
 * Then:             npm run e2e
 */
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    // Lets an environment with its own Chromium point at it.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The dev server on purpose: it runs React's development double-invocation
    // of effects, which is exactly what could make the interview ask a
    // question twice.
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
