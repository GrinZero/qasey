import { expect, test } from "@playwright/test";

test("renders a QA-verifiable result", async ({ page }) => {
  await page.setContent("<main><h1>Qasey works</h1><button>Run E2E</button></main>");
  await expect(page.getByRole("heading", { name: "Qasey works" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run E2E" })).toBeEnabled();
  await page.screenshot({ path: "artifacts/qasey-smoke.png" });
});
