import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4399";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "admin-ui.spec.ts",
  outputDir: "output/playwright/test-results",
  reporter: [
    ["line"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm --dir apps/admin-ui exec vite preview --host 127.0.0.1 --port 4399 --strictPort",
    url: `${baseURL}/admin/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
