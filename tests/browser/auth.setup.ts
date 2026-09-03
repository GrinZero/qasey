import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { authStatePath } from "./auth-state.ts";

setup("authenticate dedicated Qasey dogfood account", async ({ request }) => {
  const baseURL = requiredEnvironment("BASE_URL");
  const email = requiredEnvironment("E2E_LOGIN_EMAIL");
  const password = requiredEnvironment("E2E_LOGIN_PASSWORD");
  const expectedTenantId = requiredEnvironment("E2E_TEST_TENANT_ID");
  const origin = new URL(baseURL).origin;
  const login = await request.post(new URL("/auth/password/login", baseURL).href, {
    data: { email, password, redirectUri: "/admin" },
    headers: { origin },
  });
  expect(login.ok(), `Password login returned HTTP ${login.status()}`).toBe(true);

  const sessionResponse = await request.get(new URL("/admin/api/session", baseURL).href);
  expect(sessionResponse.ok(), `Session verification returned HTTP ${sessionResponse.status()}`).toBe(true);
  const session = await sessionResponse.json() as { tenantId?: unknown; roles?: unknown };
  expect(session.tenantId).toBe(expectedTenantId);
  expect(session.roles).toEqual(expect.arrayContaining(["user"]));

  await mkdir(dirname(authStatePath), { recursive: true });
  await request.storageState({ path: authStatePath });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required E2E environment variable ${name}`);
  return value;
}
