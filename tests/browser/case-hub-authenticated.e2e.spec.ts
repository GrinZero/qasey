import { expect, test } from "@playwright/test";

test(
  "QASEY-1 Authenticated user opens the Case Hub repository",
  {
    annotation: [
      { type: "qasey.case", description: "QASEY-1" },
      {
        type: "qasey.version",
        description: "235c6e652cc564af67126dfcce7339cabac0f5081b6df01dc3c4fa17658d4617",
      },
    ],
  },
  async ({ page }) => {
    await page.goto("/admin/apps/qasey/cases");

    await expect(page).toHaveURL(/\/admin\/apps\/qasey\/cases$/u);
    await expect(page.getByRole("heading", { name: "测试用例与变更审阅" })).toBeVisible();
    await expect(page.getByText("Case Hub · QASEY", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Case repository" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change Sets" })).toBeVisible();
  },
);
