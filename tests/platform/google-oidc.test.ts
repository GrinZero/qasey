import { describe, expect, it } from "vitest";
import { GoogleOidcError, GoogleOidcService } from "../../src/platform/auth/google-oidc.ts";

const COOKIE_PASSWORD = "test-cookie-password-that-is-longer-than-thirty-two-characters";

describe("platform Google OIDC", () => {
  it("uses state, nonce and PKCE before issuing an encrypted same-origin session", async () => {
    const now = 1_800_000_000_000;
    let expectedNonce = "";
    let tokenRequestBody = "";
    const service = new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "https://runtime.test/auth/google/callback",
      cookiePassword: COOKIE_PASSWORD,
      allowedDomains: ["moego.pet"],
      hostedDomain: "moego.pet",
      secureCookies: true,
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
        email: "qa@moego.pet",
        email_verified: true,
        hd: "moego.pet",
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
    expect(sessionCookie).not.toContain("qa@moego.pet");

    const user = await service.getCurrentUser(new Request("https://runtime.test/admin/api/session", {
      headers: { cookie: cookiePair(sessionCookie) },
    }));
    expect(user).toMatchObject({ id: "google-user-1", email: "qa@moego.pet", hostedDomain: "moego.pet", emailVerified: true });
  });

  it("rejects invalid state, untrusted domains and tampered sessions", async () => {
    let expectedNonce = "";
    const service = new GoogleOidcService({
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: "http://localhost:4111/auth/google/callback",
      cookiePassword: COOKIE_PASSWORD,
      allowedDomains: ["moego.pet"],
      secureCookies: false,
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
    })).toThrow(/GOOGLE_COOKIE_PASSWORD/u);
    expect(() => new GoogleOidcService({
      callbackUrl: "http://localhost:4111/api/auth/sso/callback",
      secureCookies: false,
    })).toThrow(/\/auth\/google\/callback/u);

    const unconfigured = new GoogleOidcService({ callbackUrl: "http://localhost:4111/auth/google/callback", secureCookies: false });
    expect(() => unconfigured.createAuthorizationRequest()).toThrow(GoogleOidcError);
  });
});

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}
