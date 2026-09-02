import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.QASEY_E2E_BASE_URL ?? "http://127.0.0.1:4111";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.spec\.ts/u,
  outputDir: "../../output/playwright/dogfood-results",
  reporter: [
    ["json", { outputFile: "../../output/playwright/dogfood-results.json" }],
    ["html", { outputFolder: "../../output/playwright/dogfood-report", open: "never" }],
  ],
  forbidOnly: true,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on",
    screenshot: "only-on-failure",
    video: "on",
    storageState: process.env.QASEY_E2E_STORAGE_STATE_PATH,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
