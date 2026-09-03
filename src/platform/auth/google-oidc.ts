import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  ActiveMembershipRequiredError,
  OrganizationInvitationResolutionError,
  type MembershipRecord,
  type OrganizationStore,
} from "./organization-store.ts";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const DEFAULT_REDIRECT_PATH = "/admin";
const ORGANIZATION_SELECTION_PATH = "/admin/select-organization";
const OAUTH_COOKIE_NAME = "qasey_google_oauth";
const ORGANIZATION_SELECTION_COOKIE_NAME = "qasey_organization_selection";
const SESSION_COOKIE_NAME = "qasey_session";
const OAUTH_TTL_SECONDS = 10 * 60;
const ORGANIZATION_SELECTION_TTL_SECONDS = 5 * 60;
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface PlatformBrowserUser {
  id: string;
  googleId?: string;
  tenantId: string;
  sessionId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  hostedDomain?: string;
  emailVerified: boolean;
  authProvider: "google" | "password";
  expiresAt: string;
}

export interface PlatformGoogleUser extends PlatformBrowserUser {
  googleId: string;
  emailVerified: true;
  authProvider: "google";
}

interface OAuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
  redirectTo: string;
  expiresAt: number;
}

interface OrganizationSelectionTransaction {
  userId: string;
  organizationIds: string[];
  redirectTo: string;
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
  organizationStore: OrganizationStore;
  tenancy: { mode: "single"; organizationId: string } | { mode: "multi" };
  bootstrapMembershipEmails?: readonly string[];
  allowSessionOrganization?(organizationId: string, userId: string): Promise<boolean>;
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

export interface OrganizationSelectionState {
  redirectTo: string;
  organizations: readonly { id: string; displayName: string }[];
}

export class GoogleOidcError extends Error {
  constructor(readonly code:
    | "not_configured"
    | "invalid_request"
    | "invalid_state"
    | "token_exchange_failed"
    | "invalid_identity"
    | "domain_denied"
    | "membership_required"
    | "membership_ambiguous"
    | "organization_selection_required") {
    super(code);
    this.name = "GoogleOidcError";
  }
}

/** Platform-owned Google OIDC with encrypted login state and opaque, revocable browser sessions. */
export class GoogleOidcService {
  readonly configured: boolean;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly callbackUrl: string;
  private readonly key: Buffer;
  private readonly allowedDomains: ReadonlySet<string>;
  private readonly hostedDomain: string | undefined;
  private readonly secureCookies: boolean;
  private readonly organizationStore: OrganizationStore;
  private readonly tenancy: GoogleOidcOptions["tenancy"];
  private readonly bootstrapMembershipEmails: ReadonlySet<string>;
  private readonly allowSessionOrganization?: GoogleOidcOptions["allowSessionOrganization"];
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
    this.organizationStore = options.organizationStore;
    this.tenancy = options.tenancy.mode === "single"
      ? { mode: "single", organizationId: requiredValue(options.tenancy.organizationId, "single-tenant organizationId") }
      : { mode: "multi" };
    this.bootstrapMembershipEmails = new Set((options.bootstrapMembershipEmails ?? [])
      .map(email => email.trim().toLowerCase())
      .filter(Boolean));
    this.allowSessionOrganization = options.allowSessionOrganization;
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

    const resolved = await this.organizationStore.resolveOrCreateIdentity({
      provider: "google",
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
      ...(claims.name ? { displayName: claims.name } : {}),
    });
    const resolution = await this.resolveLoginMembership(resolved.user.id, claims.email.toLowerCase());
    if (resolution.kind === "selection") {
      await this.revokeCurrentSession(request);
      const selection: OrganizationSelectionTransaction = {
        userId: resolved.user.id,
        organizationIds: resolution.organizationIds,
        redirectTo: transaction.redirectTo,
        expiresAt: this.now() + ORGANIZATION_SELECTION_TTL_SECONDS * 1000,
      };
      return {
        redirectTo: ORGANIZATION_SELECTION_PATH,
        cookies: [
          this.serializeCookie(
            ORGANIZATION_SELECTION_COOKIE_NAME,
            this.seal(selection, ORGANIZATION_SELECTION_COOKIE_NAME),
            ORGANIZATION_SELECTION_TTL_SECONDS,
            "/auth/organization-selection",
          ),
          this.clearCookie(SESSION_COOKIE_NAME, "/"),
          this.clearCookie(OAUTH_COOKIE_NAME, "/auth/google"),
        ],
      };
    }

    const membership = resolution.membership;
    await this.revokeCurrentSession(request);
    const session = await this.issueBrowserSession(membership.organizationId, resolved.user.id);
    return {
      redirectTo: transaction.redirectTo,
      cookies: [
        this.serializeCookie(SESSION_COOKIE_NAME, session.token, SESSION_TTL_SECONDS, "/"),
        this.clearCookie(ORGANIZATION_SELECTION_COOKIE_NAME, "/auth/organization-selection"),
        this.clearCookie(OAUTH_COOKIE_NAME, "/auth/google"),
      ],
    };
  }

  /** Reads a sealed organization-selection transaction without exposing its user identity. */
  async getOrganizationSelection(request: Request): Promise<OrganizationSelectionState | null> {
    const transaction = this.readOrganizationSelectionTransaction(request);
    if (!transaction || this.tenancy.mode !== "multi") return null;
    const allowedIds = new Set(transaction.organizationIds);
    const organizations = (await this.organizationStore.listActiveOrganizationsForUser(transaction.userId))
      .filter(organization => allowedIds.has(organization.id))
      .map(organization => ({ id: organization.id, displayName: organization.displayName }));
    if (organizations.length === 0) return null;
    return { redirectTo: transaction.redirectTo, organizations };
  }

  /** Completes selection using only the sealed user identity and its original membership candidates. */
  async completeOrganizationSelection(request: Request, organizationIdInput: string): Promise<GoogleCallbackResult> {
    const transaction = this.readOrganizationSelectionTransaction(request);
    if (!transaction || this.tenancy.mode !== "multi") throw new GoogleOidcError("organization_selection_required");
    const organizationId = organizationIdInput.trim();
    if (!organizationId || !transaction.organizationIds.includes(organizationId)) {
      throw new GoogleOidcError("membership_required");
    }
    const membership = await this.organizationStore.resolveActiveMembership(organizationId, transaction.userId);
    if (!membership) throw new GoogleOidcError("membership_required");

    await this.revokeCurrentSession(request);
    const session = await this.issueBrowserSession(membership.organizationId, transaction.userId);
    return {
      redirectTo: transaction.redirectTo,
      cookies: [
        this.serializeCookie(SESSION_COOKIE_NAME, session.token, SESSION_TTL_SECONDS, "/"),
        this.clearCookie(ORGANIZATION_SELECTION_COOKIE_NAME, "/auth/organization-selection"),
      ],
    };
  }

  async getCurrentUser(request: Request): Promise<PlatformBrowserUser | null> {
    const sessionCookie = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionCookie) return null;
    const authenticated = await this.organizationStore.authenticateBrowserSession(sessionCookie);
    if (!authenticated) return null;
    if (!this.sessionMatchesTenancy(authenticated.session.organizationId)
      && !await this.allowSessionOrganization?.(authenticated.session.organizationId, authenticated.user.id)) return null;
    const [googleIdentity, passwordIdentity] = await Promise.all([
      this.organizationStore.resolveIdentityForUser(authenticated.user.id, "google"),
      this.organizationStore.resolveIdentityForUser(authenticated.user.id, "password"),
    ]);
    const identity = googleIdentity?.email && googleIdentity.emailVerified
      ? googleIdentity
      : passwordIdentity?.email
        ? passwordIdentity
        : undefined;
    if (!identity?.email) return null;
    const authProvider = identity.provider === "google" ? "google" : "password";
    return {
      id: authenticated.user.id,
      ...(authProvider === "google" ? { googleId: identity.subject } : {}),
      tenantId: authenticated.session.organizationId,
      sessionId: authenticated.session.id,
      email: identity.email,
      ...(authenticated.user.displayName ? { name: authenticated.user.displayName } : {}),
      ...(authProvider === "google" && this.hostedDomain ? { hostedDomain: this.hostedDomain } : {}),
      emailVerified: identity.emailVerified,
      authProvider,
      expiresAt: authenticated.session.expiresAt,
    };
  }

  async revokeCurrentSession(request: Request): Promise<boolean> {
    const sessionCookie = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionCookie) return false;
    const authenticated = await this.organizationStore.authenticateBrowserSession(sessionCookie);
    if (!authenticated) return false;
    return this.organizationStore.revokeBrowserSession(
      { applicationId: "platform", tenantId: authenticated.session.organizationId },
      authenticated.session.id,
    );
  }

  clearSessionCookie(): string {
    return this.clearCookie(SESSION_COOKIE_NAME, "/");
  }

  clearLoginCookie(): string {
    return this.clearCookie(OAUTH_COOKIE_NAME, "/auth/google");
  }

  clearOrganizationSelectionCookie(): string {
    return this.clearCookie(ORGANIZATION_SELECTION_COOKIE_NAME, "/auth/organization-selection");
  }

  private async resolveLoginMembership(userId: string, email: string): Promise<
    { kind: "membership"; membership: MembershipRecord }
    | { kind: "selection"; organizationIds: string[] }
  > {
    if (this.tenancy.mode === "single") {
      const membership = await this.organizationStore.resolveMembership(this.tenancy.organizationId, userId);
      if (!membership) {
        // A configured email is an explicit, operator-owned break-glass grant.
        // Domain eligibility alone never creates membership.
        if (this.bootstrapMembershipEmails.has(email)) {
          return { kind: "membership", membership: await this.organizationStore.grantBootstrapMembership({
            organizationId: this.tenancy.organizationId,
            userId,
          }) };
        }
        return { kind: "membership", membership: await this.acceptInvitation(userId, email, this.tenancy.organizationId) };
      }
      if (membership.status === "active") return { kind: "membership", membership };
      throw new GoogleOidcError("membership_required");
    }
    const memberships = await this.organizationStore.listActiveMembershipsForUser(userId);
    if (memberships.length === 0) {
      return { kind: "membership", membership: await this.acceptInvitation(userId, email) };
    }
    if (memberships.length > 1) {
      return { kind: "selection", organizationIds: memberships.map(membership => membership.organizationId) };
    }
    return { kind: "membership", membership: memberships[0]! };
  }

  private async acceptInvitation(userId: string, verifiedEmail: string, organizationId?: string): Promise<MembershipRecord> {
    try {
      const accepted = await this.organizationStore.acceptUniqueInvitation({
        userId,
        verifiedEmail,
        ...(organizationId === undefined ? {} : { organizationId }),
      });
      return accepted.membership;
    } catch (error) {
      if (!(error instanceof OrganizationInvitationResolutionError)) throw error;
      if (error.code === "organization_invitation_ambiguous") throw new GoogleOidcError("membership_ambiguous");
      throw new GoogleOidcError("membership_required");
    }
  }

  private sessionMatchesTenancy(organizationId: string): boolean {
    return this.tenancy.mode === "multi" || organizationId === this.tenancy.organizationId;
  }

  private readOrganizationSelectionTransaction(request: Request): OrganizationSelectionTransaction | null {
    const cookie = readCookie(request, ORGANIZATION_SELECTION_COOKIE_NAME);
    if (!cookie) return null;
    const transaction = this.open<unknown>(cookie, ORGANIZATION_SELECTION_COOKIE_NAME);
    if (!isOrganizationSelectionTransaction(transaction) || transaction.expiresAt <= this.now()) return null;
    return transaction;
  }

  private async issueBrowserSession(organizationId: string, userId: string) {
    try {
      return await this.organizationStore.createBrowserSession({
        organizationId,
        userId,
        expiresAt: new Date(this.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
      });
    } catch (error) {
      // The store performs the authoritative check inside its session-creation
      // transaction, closing the membership-status TOCTOU window.
      if (error instanceof ActiveMembershipRequiredError) throw new GoogleOidcError("membership_required");
      throw error;
    }
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
      const iv = decodeCanonicalBase64Url(ivEncoded);
      const ciphertext = decodeCanonicalBase64Url(ciphertextEncoded);
      const tag = decodeCanonicalBase64Url(tagEncoded);
      if (!iv || !ciphertext || !tag) return null;
      if (iv.length !== 12 || tag.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
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

function requiredValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
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

function decodeCanonicalBase64Url(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function isOrganizationSelectionTransaction(value: unknown): value is OrganizationSelectionTransaction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.userId === "string"
    && candidate.userId.length > 0
    && Array.isArray(candidate.organizationIds)
    && candidate.organizationIds.length > 1
    && candidate.organizationIds.length <= 100
    && candidate.organizationIds.every(organizationId => typeof organizationId === "string" && organizationId.length > 0)
    && new Set(candidate.organizationIds).size === candidate.organizationIds.length
    && typeof candidate.redirectTo === "string"
    && candidate.redirectTo === safeRedirectPath(candidate.redirectTo)
    && typeof candidate.expiresAt === "number"
    && Number.isSafeInteger(candidate.expiresAt);
}
