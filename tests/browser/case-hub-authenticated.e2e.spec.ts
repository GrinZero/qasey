import { expect, test } from "@playwright/test";

test(
  "QASEY-1 Authenticated user opens the Case Hub repository",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-1" },
      {
        type: "qasey.version",
        description: "b3c6a7a1d60f21336a023f8f18c72edc6cd48024119f5d79e253d9ec66feb96d",
      },
    ],
  },
  async ({ page }) => {
    await page.goto("/admin/apps/qasey/cases");

    await expect(page).toHaveURL(/\/admin\/apps\/qasey\/cases$/u);
    await expect(page.getByRole("heading", { name: "测试用例与变更审阅", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Case repository", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change Sets", exact: true })).toBeVisible();
  },
);
