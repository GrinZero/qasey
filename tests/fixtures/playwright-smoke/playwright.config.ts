import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "artifacts/test-results",
  use: { trace: "on", screenshot: "on", video: "off" },
});
