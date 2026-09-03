import { describe, expect, it, vi } from "vitest";
import { GoogleOidcError, GoogleOidcService } from "../../src/platform/auth/google-oidc.ts";
import { ActiveMembershipRequiredError, InMemoryOrganizationStore } from "../../src/platform/auth/organization-store.ts";

const COOKIE_PASSWORD = "test-cookie-password-that-is-longer-than-thirty-two-characters";

describe("platform Google OIDC", () => {
  it("accepts only explicitly authorized temporary fixture organizations in single-tenant mode", async () => {
    const organizations = new InMemoryOrganizationStore();
    await organizations.ensureOrganization({ id: "tenant-explicit", slug: "tenant-explicit", displayName: "Explicit tenant" });
    await organizations.ensureOrganization({ id: "e2e-fixture", slug: "e2e-fixture", displayName: "E2E fixture" });
    const user = await organizations.createUser({ displayName: "Fixture user" });
    await organizations.linkIdentity({ userId: user.id, provider: "password", subject: "fixture", email: "fixture@example.test", emailVerified: true });
    await organizations.grantBootstrapMembership({ organizationId: "e2e-fixture", userId: user.id });
    const session = await organizations.createBrowserSession({ organizationId: "e2e-fixture", userId: user.id, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const allowSessionOrganization = vi.fn(async (organizationId: string, userId: string) => organizationId === "e2e-fixture" && userId === user.id);
    const service = new GoogleOidcService({
      callbackUrl: "http://runtime.test/auth/google/callback",
      secureCookies: false,
      organizationStore: organizations,
      tenancy: { mode: "single", organizationId: "tenant-explicit" },
      allowSessionOrganization,
    });

    await expect(service.getCurrentUser(new Request("http://runtime.test/admin/api/session", {
      headers: { cookie: `qasey_session=${session.token}` },
    }))).resolves.toMatchObject({ tenantId: "e2e-fixture", id: user.id });
    expect(allowSessionOrganization).toHaveBeenCalledWith("e2e-fixture", user.id);
  });

  it("uses state, nonce and PKCE before issuing an opaque, revocable single-tenant session", async () => {
    const now = 1_800_000_000_000;
    let expectedNonce = "";
    let tokenRequestBody = "";
    const organizations = new InMemoryOrganizationStore({ now: () => new Date(now) });
    await organizations.ensureOrganization({ id: "tenant-explicit", slug: "tenant-explicit", displayName: "Explicit tenant" });
    const service = new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://runtime.test/auth/google/callback",
      cookiePassword: COOKIE_PASSWORD,
      allowedDomains: ["example.com"],
      hostedDomain: "example.com",
      secureCookies: true,
      organizationStore: organizations,
      tenancy: { mode: "single", organizationId: "tenant-explicit" },
      bootstrapMembershipEmails: ["qa@example.com"],
      now: () => now,
      fetch: async (_input, init) => {
        tokenRequestBody = String(init?.body);
        return new Response(JSON.stringify({ id_token: "verified-id-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      verifyIdToken: async idToken => ({
        sub: "google-user-1",
        email: "qa@example.com",
        email_verified: true,
        hd: "example.com",
        name: "QA User",
        nonce: expectedNonce,
        iss: "https://accounts.google.com",
        aud: "client-id",
      }),
    });

    const login = service.createAuthorizationRequest("/admin#apps/qasey");
    const authorizationUrl = new URL(login.url);
    expectedNonce = authorizationUrl.searchParams.get("nonce")!;
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(login.cookie).toContain("HttpOnly");
    expect(login.cookie).toContain("SameSite=Lax");
    expect(login.cookie).toContain("Secure");

    const callback = new Request(`https://runtime.test/auth/google/callback?code=code-1&state=${authorizationUrl.searchParams.get("state")}`, {
      headers: { cookie: cookiePair(login.cookie) },
    });
    const result = await service.handleCallback(callback);
    expect(result.redirectTo).toBe("/admin#apps/qasey");
    expect(tokenRequestBody).toContain("code_verifier=");
    expect(tokenRequestBody).toContain("client_secret=client-secret");
    const sessionCookie = result.cookies.find(cookie => cookie.startsWith("qasey_session="))!;
    expect(sessionCookie).not.toContain("qa@example.com");
    const opaqueToken = cookiePair(sessionCookie).split("=", 2)[1]!;
    expect(opaqueToken).toMatch(/^qsy_session_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);
    expect(opaqueToken).not.toContain(".");

    const authenticatedRequest = new Request("https://runtime.test/admin/api/session", {
      headers: { cookie: cookiePair(sessionCookie) },
    });
    const user = await service.getCurrentUser(authenticatedRequest);
    expect(user).toMatchObject({ googleId: "google-user-1", tenantId: "tenant-explicit", email: "qa@example.com", emailVerified: true });
    expect(user?.id).not.toBe("google-user-1");
    const membership = await organizations.resolveActiveMembership("tenant-explicit", user!.id);
    expect(membership).toMatchObject({ status: "active" });

    await expect(service.revokeCurrentSession(authenticatedRequest)).resolves.toBe(true);
    await expect(service.getCurrentUser(authenticatedRequest)).resolves.toBeNull();
    const replacement = await runCallback(service, nonce => { expectedNonce = nonce; });
    const replacementCookie = replacement.cookies.find(cookie => cookie.startsWith("qasey_session="))!;

    await organizations.updateMembershipStatus(owner("tenant-explicit"), { organizationId: "tenant-explicit", userId: user!.id, status: "suspended" });
    await expect(service.getCurrentUser(new Request("https://runtime.test/admin/api/session", {
      headers: { cookie: cookiePair(replacementCookie) },
    }))).resolves.toBeNull();
    await expect(runCallback(service, nonce => { expectedNonce = nonce; }))
      .rejects.toMatchObject({ code: "membership_required" });
    await expect(organizations.resolveMembership("tenant-explicit", user!.id))
      .resolves.toMatchObject({ status: "suspended" });
  });

  it("does not turn an allowed domain into single-tenant membership", async () => {
    const now = 1_800_000_000_000;
    let expectedNonce = "";
    const organizations = new InMemoryOrganizationStore({ now: () => new Date(now) });
    await organizations.ensureOrganization({ id: "tenant-explicit", slug: "tenant-explicit", displayName: "Explicit tenant" });
    const service = new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://runtime.test/auth/google/callback",
      cookiePassword: COOKIE_PASSWORD,
      allowedDomains: ["example.com"],
      hostedDomain: "example.com",
      secureCookies: true,
      organizationStore: organizations,
      tenancy: { mode: "single", organizationId: "tenant-explicit" },
      now: () => now,
      fetch: async () => new Response(JSON.stringify({ id_token: "verified-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      verifyIdToken: async () => ({
        sub: "google-user-ordinary",
        email: "ordinary@example.com",
        email_verified: true,
        hd: "example.com",
        nonce: expectedNonce,
      }),
    });

    await expect(runCallback(service, nonce => { expectedNonce = nonce; }))
      .rejects.toMatchObject({ code: "membership_required" });
    const identity = await organizations.resolveIdentity("google", "google-user-ordinary");
    expect(identity).toBeDefined();
    await expect(organizations.resolveMembership("tenant-explicit", identity!.user.id)).resolves.toBeUndefined();

    await organizations.createInvitation({
      organizationId: "tenant-explicit",
      email: "somebody-else@example.com",
      expiresAt: new Date(now + 60_000).toISOString(),
      invitedBy: "tenant-admin",
    });
    await expect(runCallback(service, nonce => { expectedNonce = nonce; }))
      .rejects.toMatchObject({ code: "membership_required" });
    await organizations.createInvitation({
      organizationId: "tenant-explicit",
      email: "ordinary@example.com",
      expiresAt: new Date(now + 60_000).toISOString(),
      invitedBy: "tenant-admin",
    });
    const invited = await runCallback(service, nonce => { expectedNonce = nonce; });
    const invitedCookie = invited.cookies.find(cookie => cookie.startsWith("qasey_session="))!;
    await expect(service.getCurrentUser(new Request("https://runtime.test/admin/api/session", {
      headers: { cookie: cookiePair(invitedCookie) },
    }))).resolves.toMatchObject({ tenantId: "tenant-explicit", email: "ordinary@example.com" });
  });

  it("fails closed for missing or ambiguous multi-tenant invitations even when a domain is verified", async () => {
    const now = 1_800_000_000_000;
    const organizations = new InMemoryOrganizationStore({ now: () => new Date(now) });
    const alpha = await organizations.ensureOrganization({ id: "tenant-alpha", slug: "tenant-alpha", displayName: "Alpha" });
    const beta = await organizations.ensureOrganization({ id: "tenant-beta", slug: "tenant-beta", displayName: "Beta" });
    const user = await organizations.createUser({ displayName: "QA User" });
    await organizations.linkIdentity({
      userId: user.id,
      provider: "google",
      subject: "google-user-multi",
      email: "qa@example.com",
      emailVerified: true,
    });
    await organizations.verifyDomain({ organizationId: alpha.id, domain: "example.com" });
    let expectedNonce = "";
    const service = new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://runtime.test/auth/google/callback",
      cookiePassword: COOKIE_PASSWORD,
      allowedDomains: ["example.com"],
      secureCookies: true,
      organizationStore: organizations,
      tenancy: { mode: "multi" },
      now: () => now,
      fetch: async () => new Response(JSON.stringify({ id_token: "verified-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      verifyIdToken: async () => ({
        sub: "google-user-multi",
        email: "qa@example.com",
        email_verified: true,
        nonce: expectedNonce,
      }),
    });

    expect(await organizations.discoverOrganizationsForIdentity("google", "google-user-multi"))
      .toEqual([expect.objectContaining({ id: alpha.id })]);
    await expect(runCallback(service, nonce => { expectedNonce = nonce; })).rejects.toMatchObject({ code: "membership_required" });

    await organizations.createInvitation({
      organizationId: alpha.id,
      email: "qa@example.com",
      expiresAt: new Date(now + 60_000).toISOString(),
      invitedBy: "admin-alpha",
    });
    const betaInvitation = await organizations.createInvitation({
      organizationId: beta.id,
      email: "qa@example.com",
      expiresAt: new Date(now + 60_000).toISOString(),
      invitedBy: "admin-beta",
    });
    await expect(runCallback(service, nonce => { expectedNonce = nonce; })).rejects.toMatchObject({ code: "membership_ambiguous" });
    await expect(organizations.resolveMembership(alpha.id, user.id)).resolves.toBeUndefined();
    await expect(organizations.resolveMembership(beta.id, user.id)).resolves.toBeUndefined();
    await organizations.revokeInvitation({ organizationId: beta.id, invitationId: betaInvitation.id, revokedBy: "admin-beta" });
    const result = await runCallback(service, nonce => { expectedNonce = nonce; });
    const sessionCookie = result.cookies.find(cookie => cookie.startsWith("qasey_session="))!;
    await expect(service.getCurrentUser(new Request("https://runtime.test/admin/api/session", {
      headers: { cookie: cookiePair(sessionCookie) },
    }))).resolves.toMatchObject({ tenantId: alpha.id });

    await organizations.grantBootstrapMembership({ organizationId: beta.id, userId: user.id });
    await expect(service.getCurrentUser(new Request("https://runtime.test/admin/api/session", {
      headers: { cookie: cookiePair(sessionCookie) },
    }))).resolves.toMatchObject({ tenantId: alpha.id });
  });

  it("uses a sealed, short-lived transaction to select among active organizations and revalidates membership", async () => {
    let now = 1_800_000_000_000;
    let expectedNonce = "";
    const organizations = new InMemoryOrganizationStore({ now: () => new Date(now) });
    const alpha = await organizations.ensureOrganization({ id: "tenant-alpha", slug: "tenant-alpha", displayName: "Alpha Workspace" });
    const beta = await organizations.ensureOrganization({ id: "tenant-beta", slug: "tenant-beta", displayName: "Beta Workspace" });
    const gamma = await organizations.ensureOrganization({ id: "tenant-gamma", slug: "tenant-gamma", displayName: "Gamma Workspace" });
    const user = await organizations.createUser({ displayName: "Multi Organization User" });
    await organizations.linkIdentity({
      userId: user.id,
      provider: "google",
      subject: "google-user-selection",
      email: "member@example.com",
      emailVerified: true,
    });
    await organizations.grantBootstrapMembership({ organizationId: alpha.id, userId: user.id });
    await organizations.grantBootstrapMembership({ organizationId: beta.id, userId: user.id });
    const service = new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://runtime.test/auth/google/callback",
      cookiePassword: COOKIE_PASSWORD,
      allowedDomains: ["example.com"],
      secureCookies: true,
      organizationStore: organizations,
      tenancy: { mode: "multi" },
      now: () => now,
      fetch: async () => new Response(JSON.stringify({ id_token: "verified-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      verifyIdToken: async () => ({
        sub: "google-user-selection",
        email: "member@example.com",
        email_verified: true,
        nonce: expectedNonce,
      }),
    });

    const callback = await runCallback(service, nonce => { expectedNonce = nonce; });
    expect(callback.redirectTo).toBe("/admin/select-organization");
    expect(callback.cookies).toContainEqual(expect.stringMatching(/^qasey_session=; .*Max-Age=0/u));
    const selectionCookie = callback.cookies.find(cookie => cookie.startsWith("qasey_organization_selection=") && !cookie.startsWith("qasey_organization_selection=;"))!;
    expect(selectionCookie).toContain("HttpOnly");
    expect(selectionCookie).toContain("SameSite=Lax");
    expect(selectionCookie).toContain("Secure");
    expect(selectionCookie).toContain("Max-Age=300");
    expect(selectionCookie).not.toContain(user.id);
    expect(selectionCookie).not.toContain(alpha.id);
    expect(selectionCookie).not.toContain(beta.id);

    const selectionRequest = new Request("https://runtime.test/auth/organization-selection", {
      headers: { cookie: cookiePair(selectionCookie) },
    });
    await expect(service.getOrganizationSelection(selectionRequest)).resolves.toEqual({
      redirectTo: "/admin",
      organizations: [
        { id: alpha.id, displayName: "Alpha Workspace" },
        { id: beta.id, displayName: "Beta Workspace" },
      ],
    });

    // A membership granted after the callback was not part of this authentication transaction.
    await organizations.grantBootstrapMembership({ organizationId: gamma.id, userId: user.id });
    await expect(service.completeOrganizationSelection(selectionRequest, gamma.id))
      .rejects.toMatchObject({ code: "membership_required" });

    // Current status wins over the sealed snapshot.
    await organizations.updateMembershipStatus(owner(beta.id), { organizationId: beta.id, userId: user.id, status: "suspended" });
    await expect(service.completeOrganizationSelection(selectionRequest, beta.id))
      .rejects.toMatchObject({ code: "membership_required" });
    await expect(service.getOrganizationSelection(selectionRequest)).resolves.toMatchObject({
      organizations: [{ id: alpha.id, displayName: "Alpha Workspace" }],
    });
    await organizations.updateMembershipStatus(owner(beta.id), { organizationId: beta.id, userId: user.id, status: "active" });

    const membershipRace = vi.spyOn(organizations, "createBrowserSession").mockRejectedValueOnce(
      new ActiveMembershipRequiredError(beta.id, user.id),
    );
    await expect(service.completeOrganizationSelection(selectionRequest, beta.id))
      .rejects.toMatchObject({ code: "membership_required" });
    membershipRace.mockRestore();

    const completed = await service.completeOrganizationSelection(selectionRequest, beta.id);
    expect(completed.redirectTo).toBe("/admin");
    const sessionCookie = completed.cookies.find(cookie => cookie.startsWith("qasey_session=") && !cookie.startsWith("qasey_session=;"))!;
    await expect(service.getCurrentUser(new Request("https://runtime.test/admin/api/session", {
      headers: { cookie: cookiePair(sessionCookie) },
    }))).resolves.toMatchObject({ tenantId: beta.id, id: user.id });

    const encoded = cookiePair(selectionCookie).split("=", 2)[1]!;
    const tampered = `${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}`;
    const tamperedRequest = new Request("https://runtime.test/auth/organization-selection", {
      headers: { cookie: `qasey_organization_selection=${tampered}` },
    });
    await expect(service.getOrganizationSelection(tamperedRequest)).resolves.toBeNull();
    await expect(service.completeOrganizationSelection(tamperedRequest, alpha.id))
      .rejects.toMatchObject({ code: "organization_selection_required" });

    const expiringCallback = await runCallback(service, nonce => { expectedNonce = nonce; });
    const expiringCookie = expiringCallback.cookies.find(cookie => cookie.startsWith("qasey_organization_selection=") && !cookie.startsWith("qasey_organization_selection=;"))!;
    now += 5 * 60 * 1000 + 1;
    const expiredRequest = new Request("https://runtime.test/auth/organization-selection", {
      headers: { cookie: cookiePair(expiringCookie) },
    });
    await expect(service.getOrganizationSelection(expiredRequest)).resolves.toBeNull();
    await expect(service.completeOrganizationSelection(expiredRequest, alpha.id))
      .rejects.toMatchObject({ code: "organization_selection_required" });
  });

  it("rejects invalid state, untrusted domains and tampered sessions", async () => {
    let expectedNonce = "";
    const service = new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "http://localhost:4111/auth/google/callback",
      cookiePassword: COOKIE_PASSWORD,
      allowedDomains: ["example.com"],
      secureCookies: false,
      organizationStore: new InMemoryOrganizationStore(),
      tenancy: { mode: "single", organizationId: "local" },
      fetch: async () => new Response(JSON.stringify({ id_token: "token" }), { status: 200 }),
      verifyIdToken: async () => ({
        sub: "user-1", email: "user@outside.test", email_verified: true, nonce: expectedNonce,
      }),
    });
    const login = service.createAuthorizationRequest("https://evil.test/steal");
    const authorizationUrl = new URL(login.url);
    expectedNonce = authorizationUrl.searchParams.get("nonce")!;

    await expect(service.handleCallback(new Request("http://localhost:4111/auth/google/callback?code=code&state=wrong", {
      headers: { cookie: cookiePair(login.cookie) },
    }))).rejects.toMatchObject({ code: "invalid_state" });

    await expect(service.handleCallback(new Request(`http://localhost:4111/auth/google/callback?code=code&state=${authorizationUrl.searchParams.get("state")}`, {
      headers: { cookie: cookiePair(login.cookie) },
    }))).rejects.toMatchObject({ code: "domain_denied" });

    await expect(service.getCurrentUser(new Request("http://localhost:4111/admin", {
      headers: { cookie: "qasey_session=tampered.value.cookie" },
    }))).resolves.toBeNull();
  });

  it("fails closed when production session secrets or OAuth credentials are absent", () => {
    expect(() => new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://runtime.test/auth/google/callback",
      secureCookies: true,
      organizationStore: new InMemoryOrganizationStore(),
      tenancy: { mode: "single", organizationId: "local" },
    })).toThrow(/GOOGLE_COOKIE_PASSWORD/u);
    expect(() => new GoogleOidcService({
      callbackUrl: "http://localhost:4111/api/auth/sso/callback",
      secureCookies: false,
      organizationStore: new InMemoryOrganizationStore(),
      tenancy: { mode: "single", organizationId: "local" },
    })).toThrow(/\/auth\/google\/callback/u);

    const unconfigured = new GoogleOidcService({
      callbackUrl: "http://localhost:4111/auth/google/callback",
      secureCookies: false,
      organizationStore: new InMemoryOrganizationStore(),
      tenancy: { mode: "single", organizationId: "local" },
    });
    expect(() => unconfigured.createAuthorizationRequest()).toThrow(GoogleOidcError);
  });
});

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

function owner(tenantId: string) {
  return { applicationId: "platform", tenantId };
}

async function runCallback(service: GoogleOidcService, nonce: (value: string) => void) {
  const login = service.createAuthorizationRequest("/admin");
  const authorizationUrl = new URL(login.url);
  nonce(authorizationUrl.searchParams.get("nonce")!);
  return service.handleCallback(new Request(
    `https://runtime.test/auth/google/callback?code=code&state=${authorizationUrl.searchParams.get("state")}`,
    { headers: { cookie: cookiePair(login.cookie) } },
  ));
}
