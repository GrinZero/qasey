import { expect, test } from "@playwright/test";

test("dedicated dogfood account opens the configured Qasey tenant", async ({ page }) => {
  const expectedTenantId = process.env.E2E_TEST_TENANT_ID;
  if (!expectedTenantId?.trim()) throw new Error("Missing required E2E environment variable E2E_TEST_TENANT_ID");

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin(?:\/|$)/u);

  const sessionResponse = await page.request.get("/admin/api/session");
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json() as { tenantId?: unknown; roles?: unknown };
  expect(session.tenantId).toBe(expectedTenantId);
  expect(session.roles).toEqual(expect.arrayContaining(["user"]));
});
