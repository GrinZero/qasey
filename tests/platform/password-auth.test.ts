import { describe, expect, it, vi } from "vitest";
import {
  InMemoryOrganizationStore,
} from "../../src/platform/auth/organization-store.ts";
import {
  PASSWORD_MIN_LENGTH,
  PasswordAuthService,
  hashPassword,
  verifyPassword,
  type PasswordAuthOptions,
} from "../../src/platform/auth/password-auth.ts";

const NOW = Date.parse("2026-08-27T08:00:00.000Z");
const ORGANIZATION_ID = "tenant-password";
const EMAIL = "member@example.invalid";
const PASSWORD = "synthetic-password-phrase";
const TEST_HASH_PREFIX = "test-password-hash-with-padding:";

describe("password authentication", () => {
  it("requires ten characters for registration while allowing legacy short passwords at login", async () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    const { service, store } = await authFixture();

    await expect(service.register({
      email: "short-registration@example.invalid",
      password: "123456789",
      request: authRequest("register"),
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(service.register({
      email: "minimum-registration@example.invalid",
      password: "1234567890",
      request: authRequest("register"),
    })).resolves.toMatchObject({ redirectTo: "/admin" });

    await store.registerPasswordUser({
      organizationId: ORGANIZATION_ID,
      email: "legacy@example.invalid",
      passwordHash: `${TEST_HASH_PREFIX}short`,
    });
    await expect(loginWith(service, "legacy@example.invalid", "short"))
      .resolves.toMatchObject({ redirectTo: "/admin" });
  });

  it("creates independently salted, versioned scrypt hashes and verifies without accepting bad input", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    const [version, cost, blockSize, parallelization, salt, digest] = first.split("$");

    expect(version).toBe("qasey-scrypt-v1");
    expect([cost, blockSize, parallelization]).toEqual(["32768", "8", "1"]);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(digest!, "base64url")).toHaveLength(64);
    expect(first).not.toBe(second);
    expect(first).not.toContain(PASSWORD);
    await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword("different-synthetic-password", first)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, "malformed-password-hash")).resolves.toBe(false);
  });

  it("registers a normalized account, issues secure cookies, preserves safe redirects, and rejects duplicates", async () => {
    const { service, store } = await authFixture({ secureCookies: true });
    const registered = await service.register({
      email: "  Member@Example.Invalid ",
      password: PASSWORD,
      displayName: "  Synthetic Member  ",
      redirectTo: "https://attacker.example.invalid/steal",
      request: authRequest("register"),
    });

    expect(registered.redirectTo).toBe("/admin");
    expect(registered.cookie).toMatch(
      /^qasey_session=qsy_session_[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/u,
    );
    await expect(store.resolvePasswordCredential("MEMBER@EXAMPLE.INVALID")).resolves.toMatchObject({
      user: { displayName: "Synthetic Member" },
      identity: { provider: "password", subject: EMAIL, email: EMAIL, emailVerified: false },
      credential: { passwordHash: `${TEST_HASH_PREFIX}${PASSWORD}` },
    });

    await expect(service.register({
      email: "MEMBER@EXAMPLE.INVALID",
      password: PASSWORD,
      request: authRequest("register"),
    })).rejects.toMatchObject({ code: "account_exists" });

    const loggedIn = await service.login({
      email: EMAIL,
      password: PASSWORD,
      redirectTo: "/admin/apps/qasey?tab=runs#latest",
      request: authRequest("login"),
    });
    expect(loggedIn.redirectTo).toBe("/admin/apps/qasey?tab=runs#latest");
    expect(loggedIn.cookie).toContain("; HttpOnly; SameSite=Lax; Max-Age=43200; Secure");
  });

  it("uses the stored hash for wrong passwords and a fixed dummy hash for unknown accounts", async () => {
    const passwordVerify = vi.fn(async (password: string, encodedHash: string) => (
      encodedHash === `${TEST_HASH_PREFIX}${password}`
    ));
    const { service } = await authFixture({ passwordVerify });
    await service.register({ email: EMAIL, password: PASSWORD, request: authRequest("register") });

    await expect(service.login({
      email: EMAIL,
      password: "wrong-synthetic-password",
      request: authRequest("login"),
    })).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(service.login({
      email: "unknown@example.invalid",
      password: "wrong-synthetic-password",
      request: authRequest("login"),
    })).rejects.toMatchObject({ code: "invalid_credentials" });

    expect(passwordVerify).toHaveBeenCalledTimes(2);
    expect(passwordVerify.mock.calls[0]?.[1]).toBe(`${TEST_HASH_PREFIX}${PASSWORD}`);
    expect(passwordVerify.mock.calls[1]?.[1]).toMatch(
      /^qasey-scrypt-v1\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u,
    );
  });

  it("requires an active membership and invalidates an existing session when the membership is suspended", async () => {
    const { service, store } = await authFixture();
    const registered = await service.register({
      email: EMAIL,
      password: PASSWORD,
      request: authRequest("register"),
    });
    const credential = await store.resolvePasswordCredential(EMAIL);
    const token = sessionToken(registered.cookie);

    await expect(store.authenticateBrowserSession(token)).resolves.toBeDefined();
    await store.updateMembershipStatus(
      { applicationId: "platform", tenantId: ORGANIZATION_ID },
      { organizationId: ORGANIZATION_ID, userId: credential!.user.id, status: "suspended" },
    );
    await expect(store.authenticateBrowserSession(token)).resolves.toBeUndefined();
    await expect(service.login({
      email: EMAIL,
      password: PASSWORD,
      request: authRequest("login"),
    })).rejects.toMatchObject({ code: "membership_required" });
  });

  it("limits attempts per normalized account and resets the window after success or expiry", async () => {
    let now = NOW;
    const { service } = await authFixture({
      attemptLimit: 2,
      attemptWindowMs: 1_000,
      now: () => now,
    });
    await service.register({ email: EMAIL, password: PASSWORD, request: authRequest("register") });

    await expect(loginWith(service, EMAIL, "wrong-synthetic-password")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await expect(loginWith(service, EMAIL, PASSWORD)).resolves.toMatchObject({ redirectTo: "/admin" });

    await expect(loginWith(service, " MEMBER@EXAMPLE.INVALID ", "wrong-synthetic-password"))
      .rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(loginWith(service, EMAIL, "wrong-synthetic-password"))
      .rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(loginWith(service, EMAIL, PASSWORD)).rejects.toMatchObject({ code: "rate_limited" });

    await expect(loginWith(service, "other@example.invalid", "wrong-synthetic-password"))
      .rejects.toMatchObject({ code: "invalid_credentials" });
    now += 1_001;
    await expect(loginWith(service, EMAIL, "wrong-synthetic-password"))
      .rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("blocks registration before hashing when self-registration is disabled", async () => {
    const passwordHash = vi.fn(async (password: string) => `${TEST_HASH_PREFIX}${password}`);
    const { service, store } = await authFixture({ registrationEnabled: false, passwordHash });

    await expect(service.register({
      email: EMAIL,
      password: PASSWORD,
      request: authRequest("register"),
    })).rejects.toMatchObject({ code: "registration_disabled" });
    expect(passwordHash).not.toHaveBeenCalled();
    await expect(store.resolvePasswordCredential(EMAIL)).resolves.toBeUndefined();
  });
});

async function authFixture(overrides: Partial<PasswordAuthOptions> = {}) {
  const store = new InMemoryOrganizationStore({ now: () => new Date(NOW) });
  await store.ensureOrganization({
    id: ORGANIZATION_ID,
    slug: "password-tenant",
    displayName: "Password tenant",
  });
  const service = new PasswordAuthService({
    enabled: true,
    registrationEnabled: true,
    organizationId: ORGANIZATION_ID,
    organizationStore: store,
    secureCookies: false,
    now: () => NOW,
    passwordHash: async password => `${TEST_HASH_PREFIX}${password}`,
    passwordVerify: async (password, encodedHash) => encodedHash === `${TEST_HASH_PREFIX}${password}`,
    ...overrides,
  });
  return { service, store };
}

function authRequest(action: "register" | "login"): Request {
  return new Request(`https://runtime.test/auth/password/${action}`, { method: "POST" });
}

function loginWith(service: PasswordAuthService, email: string, password: string) {
  return service.login({ email, password, request: authRequest("login") });
}

function sessionToken(cookie: string): string {
  const token = /^qasey_session=([^;]+)/u.exec(cookie)?.[1];
  if (!token) throw new Error("session cookie is missing");
  return token;
}
