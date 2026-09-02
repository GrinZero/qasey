import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import {
  ActiveMembershipRequiredError,
  PasswordIdentityAlreadyExistsError,
  type OrganizationStore,
} from "./organization-store.ts";

const PASSWORD_PROVIDER = "password";
const SESSION_COOKIE_NAME = "qasey_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PASSWORD_HASH_VERSION = "qasey-scrypt-v1";
const SCRYPT_COST = 2 ** 15;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const DEFAULT_ATTEMPT_LIMIT = 5;
const DEFAULT_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_REDIRECT_PATH = "/admin";
const DUMMY_PASSWORD_HASH = encodePasswordHash(Buffer.alloc(SCRYPT_SALT_LENGTH), Buffer.alloc(SCRYPT_KEY_LENGTH));

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordAuthErrorCode =
  | "not_configured"
  | "registration_disabled"
  | "invalid_input"
  | "invalid_credentials"
  | "account_exists"
  | "membership_required"
  | "rate_limited";

export class PasswordAuthError extends Error {
  constructor(readonly code: PasswordAuthErrorCode) {
    super(code);
    this.name = "PasswordAuthError";
  }
}

export interface PasswordAuthResult {
  redirectTo: string;
  cookie: string;
}

export interface PasswordAuthOptions {
  enabled: boolean;
  registrationEnabled: boolean;
  organizationId?: string;
  organizationStore: OrganizationStore;
  secureCookies: boolean;
  now?: () => number;
  attemptLimit?: number;
  attemptWindowMs?: number;
  passwordHash?: (password: string) => Promise<string>;
  passwordVerify?: (password: string, encodedHash: string) => Promise<boolean>;
}

interface AttemptWindow {
  count: number;
  expiresAt: number;
}

/** Email/password authentication for a single-tenant installation. */
export class PasswordAuthService {
  readonly configured: boolean;
  readonly registrationConfigured: boolean;
  private readonly organizationId: string | undefined;
  private readonly organizationStore: OrganizationStore;
  private readonly secureCookies: boolean;
  private readonly now: () => number;
  private readonly attemptLimit: number;
  private readonly attemptWindowMs: number;
  private readonly passwordHash: (password: string) => Promise<string>;
  private readonly passwordVerify: (password: string, encodedHash: string) => Promise<boolean>;
  private readonly attempts = new Map<string, AttemptWindow>();

  constructor(options: PasswordAuthOptions) {
    this.organizationId = normalizedOptionalText(options.organizationId);
    this.configured = options.enabled && Boolean(this.organizationId);
    this.registrationConfigured = this.configured && options.registrationEnabled;
    this.organizationStore = options.organizationStore;
    this.secureCookies = options.secureCookies;
    this.now = options.now ?? Date.now;
    this.attemptLimit = positiveInteger(options.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT, "attemptLimit");
    this.attemptWindowMs = positiveInteger(options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS, "attemptWindowMs");
    this.passwordHash = options.passwordHash ?? hashPassword;
    this.passwordVerify = options.passwordVerify ?? verifyPassword;
  }

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    redirectTo?: string;
    request: Request;
  }): Promise<PasswordAuthResult> {
    this.assertConfigured();
    if (!this.registrationConfigured) throw new PasswordAuthError("registration_disabled");
    const email = normalizeEmail(input.email);
    const password = validRegistrationPassword(input.password);
    const displayName = normalizeDisplayName(input.displayName);
    const attemptKey = authAttemptKey("register", email);
    this.consumeAttempt(attemptKey);
    const passwordHash = await this.passwordHash(password);
    let registered;
    try {
      registered = await this.organizationStore.registerPasswordUser({
        organizationId: this.organizationId!,
        email,
        passwordHash,
        ...(displayName ? { displayName } : {}),
      });
    } catch (error) {
      if (error instanceof PasswordIdentityAlreadyExistsError) throw new PasswordAuthError("account_exists");
      throw error;
    }
    this.clearAttempts(attemptKey);
    await this.revokeCurrentSession(input.request);
    return this.issueSession(registered.user.id, safeRedirectPath(input.redirectTo));
  }

  async login(input: {
    email: string;
    password: string;
    redirectTo?: string;
    request: Request;
  }): Promise<PasswordAuthResult> {
    this.assertConfigured();
    const email = normalizeEmail(input.email);
    const password = validLoginPassword(input.password);
    const attemptKey = authAttemptKey("login", email);
    this.consumeAttempt(attemptKey);
    const resolved = await this.organizationStore.resolvePasswordCredential(email);
    const verified = await this.passwordVerify(password, resolved?.credential.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!resolved || !verified) throw new PasswordAuthError("invalid_credentials");
    const membership = await this.organizationStore.resolveActiveMembership(this.organizationId!, resolved.user.id);
    if (!membership) throw new PasswordAuthError("membership_required");
    this.clearAttempts(attemptKey);
    await this.revokeCurrentSession(input.request);
    return this.issueSession(resolved.user.id, safeRedirectPath(input.redirectTo));
  }

  private async issueSession(userId: string, redirectTo: string): Promise<PasswordAuthResult> {
    try {
      const session = await this.organizationStore.createBrowserSession({
        organizationId: this.organizationId!,
        userId,
        expiresAt: new Date(this.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
      });
      return {
        redirectTo,
        cookie: serializeSessionCookie(session.token, SESSION_TTL_SECONDS, this.secureCookies),
      };
    } catch (error) {
      if (error instanceof ActiveMembershipRequiredError) throw new PasswordAuthError("membership_required");
      throw error;
    }
  }

  private async revokeCurrentSession(request: Request): Promise<void> {
    const token = readCookie(request, SESSION_COOKIE_NAME);
    if (!token) return;
    const authenticated = await this.organizationStore.authenticateBrowserSession(token);
    if (!authenticated) return;
    await this.organizationStore.revokeBrowserSession(
      { applicationId: "platform", tenantId: authenticated.session.organizationId },
      authenticated.session.id,
    );
  }

  private assertConfigured(): void {
    if (!this.configured) throw new PasswordAuthError("not_configured");
  }

  private consumeAttempt(key: string): void {
    const now = this.now();
    const existing = this.attempts.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.attempts.set(key, { count: 1, expiresAt: now + this.attemptWindowMs });
      this.pruneAttempts(now);
      return;
    }
    if (existing.count >= this.attemptLimit) throw new PasswordAuthError("rate_limited");
    existing.count += 1;
  }

  private clearAttempts(key: string): void {
    this.attempts.delete(key);
  }

  private pruneAttempts(now: number): void {
    if (this.attempts.size < 1_000) return;
    for (const [key, attempt] of this.attempts) {
      if (attempt.expiresAt <= now) this.attempts.delete(key);
    }
  }
}

export async function hashPassword(passwordInput: string): Promise<string> {
  const password = validRegistrationPassword(passwordInput);
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derived = await deriveScrypt(password, salt, SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELIZATION);
  return encodePasswordHash(salt, derived);
}

export async function verifyPassword(passwordInput: string, encodedHash: string): Promise<boolean> {
  let password: string;
  try {
    password = validLoginPassword(passwordInput);
  } catch {
    password = "invalid-password-shape";
  }
  const parsed = parsePasswordHash(encodedHash);
  const comparison = parsed ?? parsePasswordHash(DUMMY_PASSWORD_HASH)!;
  const derived = await deriveScrypt(
    password,
    comparison.salt,
    comparison.cost,
    comparison.blockSize,
    comparison.parallelization,
  );
  return Boolean(parsed)
    && derived.length === comparison.digest.length
    && timingSafeEqual(derived, comparison.digest);
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function encodePasswordHash(salt: Buffer, digest: Buffer): string {
  return [
    PASSWORD_HASH_VERSION,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

function parsePasswordHash(value: string): {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  digest: Buffer;
} | undefined {
  const [version, costValue, blockSizeValue, parallelizationValue, saltValue, digestValue, extra] = value.split("$");
  if (extra !== undefined || version !== PASSWORD_HASH_VERSION || !costValue || !blockSizeValue
    || !parallelizationValue || !saltValue || !digestValue) return undefined;
  const cost = Number(costValue);
  const blockSize = Number(blockSizeValue);
  const parallelization = Number(parallelizationValue);
  if (cost !== SCRYPT_COST || blockSize !== SCRYPT_BLOCK_SIZE || parallelization !== SCRYPT_PARALLELIZATION) return undefined;
  const salt = canonicalBase64url(saltValue);
  const digest = canonicalBase64url(digestValue);
  if (!salt || salt.length !== SCRYPT_SALT_LENGTH || !digest || digest.length !== SCRYPT_KEY_LENGTH) return undefined;
  return { cost, blockSize, parallelization, salt, digest };
}

function canonicalBase64url(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function normalizeEmail(input: string): string {
  const value = input.trim().toLowerCase();
  if (value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) throw new PasswordAuthError("invalid_input");
  return value;
}

function validRegistrationPassword(input: string): string {
  const length = [...input].length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH || Buffer.byteLength(input, "utf8") > 512) {
    throw new PasswordAuthError("invalid_input");
  }
  return input;
}

function validLoginPassword(input: string): string {
  const length = [...input].length;
  if (length < 1 || length > PASSWORD_MAX_LENGTH || Buffer.byteLength(input, "utf8") > 512) {
    throw new PasswordAuthError("invalid_input");
  }
  return input;
}

function normalizeDisplayName(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const value = input.trim();
  if (!value || [...value].length > 100) throw new PasswordAuthError("invalid_input");
  return value;
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

function serializeSessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return entry.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

function normalizedOptionalText(input: string | undefined): string | undefined {
  const value = input?.trim();
  return value || undefined;
}

function authAttemptKey(kind: "login" | "register", email: string): string {
  return `${kind}:${createHash("sha256").update(email).digest("hex")}`;
}

function positiveInteger(input: number, field: string): number {
  if (!Number.isInteger(input) || input < 1) throw new RangeError(`${field} must be a positive integer`);
  return input;
}
