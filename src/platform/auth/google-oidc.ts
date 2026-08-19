import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const DEFAULT_REDIRECT_PATH = "/admin";
const OAUTH_COOKIE_NAME = "qasey_google_oauth";
const SESSION_COOKIE_NAME = "qasey_session";
const OAUTH_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface PlatformGoogleUser {
  id: string;
  googleId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  hostedDomain?: string;
  emailVerified: true;
  expiresAt: string;
}

interface OAuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
  redirectTo: string;
  expiresAt: number;
}

interface SessionPayload {
  user: PlatformGoogleUser;
  expiresAt: number;
}

interface GoogleIdClaims extends JWTPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  picture?: string;
  nonce?: string;
}

export interface GoogleOidcOptions {
  clientId?: string;
  clientSecret?: string;
  callbackUrl: string;
  cookiePassword?: string;
  allowedDomains?: readonly string[];
  hostedDomain?: string;
  secureCookies: boolean;
  fetch?: typeof fetch;
  verifyIdToken?: (idToken: string) => Promise<GoogleIdClaims>;
  now?: () => number;
}

export interface GoogleAuthorizationRequest {
  url: string;
  cookie: string;
}

export interface GoogleCallbackResult {
  redirectTo: string;
  cookies: readonly string[];
}

export class GoogleOidcError extends Error {
  constructor(readonly code: "not_configured" | "invalid_request" | "invalid_state" | "token_exchange_failed" | "invalid_identity" | "domain_denied") {
    super(code);
    this.name = "GoogleOidcError";
  }
}

/** Platform-owned Google OIDC and encrypted browser session implementation. */
export class GoogleOidcService {
  readonly configured: boolean;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly callbackUrl: string;
  private readonly key: Buffer;
  private readonly allowedDomains: ReadonlySet<string>;
  private readonly hostedDomain: string | undefined;
  private readonly secureCookies: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly verifyIdTokenImpl: (idToken: string) => Promise<GoogleIdClaims>;
  private readonly now: () => number;

  constructor(options: GoogleOidcOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.configured = Boolean(this.clientId && this.clientSecret);
    const callbackUrl = new URL(options.callbackUrl);
    if (callbackUrl.pathname !== "/auth/google/callback" || callbackUrl.search || callbackUrl.hash) {
      throw new Error("GOOGLE_REDIRECT_URI must point to /auth/google/callback");
    }
    this.callbackUrl = callbackUrl.toString();
    if (options.secureCookies && callbackUrl.protocol !== "https:") {
      throw new Error("Google OAuth callback URL must use HTTPS when secure cookies are enabled");
    }
    if (options.cookiePassword && options.cookiePassword.length < 32) {
      throw new Error("GOOGLE_COOKIE_PASSWORD must be at least 32 characters");
    }
    if (this.configured && options.secureCookies && !options.cookiePassword) {
      throw new Error("GOOGLE_COOKIE_PASSWORD is required for production Google OAuth sessions");
    }
    this.key = createHash("sha256").update(options.cookiePassword ?? randomBytes(48)).digest();
    this.allowedDomains = new Set((options.allowedDomains ?? []).map(normalizeDomain).filter((domain): domain is string => Boolean(domain)));
    this.hostedDomain = normalizeDomain(options.hostedDomain);
    this.secureCookies = options.secureCookies;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    if (options.verifyIdToken) {
      this.verifyIdTokenImpl = options.verifyIdToken;
    } else {
      const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
      this.verifyIdTokenImpl = async idToken => {
        if (!this.clientId) throw new GoogleOidcError("not_configured");
        const { payload } = await jwtVerify(idToken, jwks, {
          audience: this.clientId,
          issuer: GOOGLE_ISSUERS,
        });
        return payload as GoogleIdClaims;
      };
    }
  }

  createAuthorizationRequest(redirectTarget?: string): GoogleAuthorizationRequest {
    this.assertConfigured();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const transaction: OAuthTransaction = {
      state,
      nonce,
      verifier,
      redirectTo: safeRedirectPath(redirectTarget),
      expiresAt: this.now() + OAUTH_TTL_SECONDS * 1000,
    };
    const url = new URL(GOOGLE_AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.callbackUrl,
      response_type: "code",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(this.hostedDomain ? { hd: this.hostedDomain } : {}),
    }).toString();
    return {
      url: url.toString(),
      cookie: this.serializeCookie(OAUTH_COOKIE_NAME, this.seal(transaction, OAUTH_COOKIE_NAME), OAUTH_TTL_SECONDS, "/auth/google"),
    };
  }

  async handleCallback(request: Request): Promise<GoogleCallbackResult> {
    this.assertConfigured();
    const url = new URL(request.url);
    if (url.searchParams.get("error")) throw new GoogleOidcError("invalid_request");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const transactionCookie = readCookie(request, OAUTH_COOKIE_NAME);
    if (!code || !state || !transactionCookie) throw new GoogleOidcError("invalid_request");
    const transaction = this.open<OAuthTransaction>(transactionCookie, OAUTH_COOKIE_NAME);
    if (!transaction || transaction.expiresAt <= this.now() || !safeEqual(state, transaction.state)) {
      throw new GoogleOidcError("invalid_state");
    }

    const tokenResponse = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        redirect_uri: this.callbackUrl,
        grant_type: "authorization_code",
        code_verifier: transaction.verifier,
      }),
    });
    if (!tokenResponse.ok) throw new GoogleOidcError("token_exchange_failed");
    const tokens = await tokenResponse.json() as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new GoogleOidcError("token_exchange_failed");

    let claims: GoogleIdClaims;
    try {
      claims = await this.verifyIdTokenImpl(tokens.id_token);
    } catch (error) {
      if (error instanceof GoogleOidcError) throw error;
      throw new GoogleOidcError("invalid_identity");
    }
    if (!claims.sub || !claims.email || claims.email_verified !== true || !claims.nonce || !safeEqual(claims.nonce, transaction.nonce)) {
      throw new GoogleOidcError("invalid_identity");
    }
    const emailDomain = normalizeDomain(claims.email.split("@").at(-1));
    const hostedDomain = normalizeDomain(claims.hd);
    if (this.allowedDomains.size > 0 && (!emailDomain || !this.allowedDomains.has(emailDomain))) {
      throw new GoogleOidcError("domain_denied");
    }
    if (this.hostedDomain && hostedDomain !== this.hostedDomain) throw new GoogleOidcError("domain_denied");

    const sessionExpiresAt = this.now() + SESSION_TTL_SECONDS * 1000;
    const user: PlatformGoogleUser = {
      id: claims.sub,
      googleId: claims.sub,
      email: claims.email.toLowerCase(),
      ...(claims.name ? { name: claims.name } : {}),
      ...(claims.picture ? { avatarUrl: claims.picture } : {}),
      ...(hostedDomain ? { hostedDomain } : {}),
      emailVerified: true,
      expiresAt: new Date(sessionExpiresAt).toISOString(),
    };
    const session: SessionPayload = { user, expiresAt: sessionExpiresAt };
    return {
      redirectTo: transaction.redirectTo,
      cookies: [
        this.serializeCookie(SESSION_COOKIE_NAME, this.seal(session, SESSION_COOKIE_NAME), SESSION_TTL_SECONDS, "/"),
        this.clearCookie(OAUTH_COOKIE_NAME, "/auth/google"),
      ],
    };
  }

  async getCurrentUser(request: Request): Promise<PlatformGoogleUser | null> {
    const sessionCookie = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionCookie) return null;
    const session = this.open<SessionPayload>(sessionCookie, SESSION_COOKIE_NAME);
    if (!session || session.expiresAt <= this.now()) return null;
    const user = session.user;
    if (!user?.id || !user.googleId || !user.email || user.emailVerified !== true) return null;
    return user;
  }

  clearSessionCookie(): string {
    return this.clearCookie(SESSION_COOKIE_NAME, "/");
  }

  clearLoginCookie(): string {
    return this.clearCookie(OAUTH_COOKIE_NAME, "/auth/google");
  }

  private assertConfigured(): void {
    if (!this.configured) throw new GoogleOidcError("not_configured");
  }

  private seal(value: unknown, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }

  private open<T>(token: string, purpose: string): T | null {
    try {
      const [ivEncoded, ciphertextEncoded, tagEncoded] = token.split(".");
      if (!ivEncoded || !ciphertextEncoded || !tagEncoded) return null;
      const iv = Buffer.from(ivEncoded, "base64url");
      const tag = Buffer.from(tagEncoded, "base64url");
      if (iv.length !== 12 || tag.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch {
      return null;
    }
  }

  private serializeCookie(name: string, value: string, maxAge: number, path: string): string {
    return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secureCookies ? "; Secure" : ""}`;
  }

  private clearCookie(name: string, path: string): string {
    return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookies ? "; Secure" : ""}`;
  }
}

function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function safeRedirectPath(value: string | undefined): string {
  if (!value) return DEFAULT_REDIRECT_PATH;
  try {
    const base = new URL("https://qasey.invalid");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith("/")) return DEFAULT_REDIRECT_PATH;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_REDIRECT_PATH;
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return entry.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
