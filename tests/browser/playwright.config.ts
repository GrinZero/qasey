import "../../src/load-env.ts";
import { defineConfig, devices } from "@playwright/test";
import { authStatePath } from "./auth-state.ts";

process.env.BASE_URL ??= "http://localhost:4111";
const baseURL = process.env.BASE_URL;

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
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/u },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: authStatePath },
    },
  ],
});
