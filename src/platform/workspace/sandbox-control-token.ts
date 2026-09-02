import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { z } from "zod";
import { SandboxSessionClaimSchema, type SandboxLeaseScope } from "./sandbox-protocol.ts";

export const SANDBOX_CONTROL_TOKEN_ISSUER = "qasey-control-plane";
export const SANDBOX_CONTROL_TOKEN_AUDIENCE = "qasey-sandbox-runtime";
export const SANDBOX_CONTROL_TOKEN_TTL_SECONDS = 30;
const SANDBOX_CONTROL_TOKEN_CLOCK_TOLERANCE_SECONDS = 5;
const MINIMUM_CONTROL_KEY_BYTES = 32;

export type SandboxSessionClaim = z.infer<typeof SandboxSessionClaimSchema>;

export interface SandboxControlTokenInput {
  controlKey: string;
  scope: SandboxLeaseScope;
  claim: SandboxSessionClaim;
  now?: Date;
}

export interface VerifiedSandboxControlToken extends SandboxLeaseScope {
  jti: string;
  expiresAt: Date;
}

export class SandboxControlTokenError extends Error {
  constructor() {
    super("Invalid sandbox control token");
    this.name = "SandboxControlTokenError";
  }
}

export async function signSandboxControlToken(input: SandboxControlTokenInput): Promise<string> {
  const key = sandboxControlKey(input.controlKey);
  const claim = SandboxSessionClaimSchema.parse(input.claim);
  assertScopeMatchesClaim(input.scope, claim);
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  return new SignJWT({
    application_id: input.scope.applicationId,
    tenant_id: input.scope.tenantId,
    session_id: claim.sessionId,
    workspace_id: claim.workspaceId,
    generation: claim.generation,
    claim_sha256: sandboxClaimBodyHash(claim),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SANDBOX_CONTROL_TOKEN_ISSUER)
    .setAudience(SANDBOX_CONTROL_TOKEN_AUDIENCE)
    .setSubject(`sandbox-session:${claim.sessionId}`)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SANDBOX_CONTROL_TOKEN_TTL_SECONDS)
    .sign(key);
}

export async function verifySandboxControlToken(input: {
  controlKey: string;
  token: string;
  claim: SandboxSessionClaim;
  now?: Date;
}): Promise<VerifiedSandboxControlToken> {
  try {
    const key = sandboxControlKey(input.controlKey);
    const claim = SandboxSessionClaimSchema.parse(input.claim);
    const { payload } = await jwtVerify(input.token, key, {
      algorithms: ["HS256"],
      typ: "JWT",
      issuer: SANDBOX_CONTROL_TOKEN_ISSUER,
      audience: SANDBOX_CONTROL_TOKEN_AUDIENCE,
      requiredClaims: [
        "sub", "jti", "iat", "exp", "application_id", "tenant_id", "session_id",
        "workspace_id", "generation", "claim_sha256",
      ],
      maxTokenAge: SANDBOX_CONTROL_TOKEN_TTL_SECONDS + SANDBOX_CONTROL_TOKEN_CLOCK_TOLERANCE_SECONDS,
      clockTolerance: SANDBOX_CONTROL_TOKEN_CLOCK_TOLERANCE_SECONDS,
      ...(input.now ? { currentDate: input.now } : {}),
    });
    const scope = {
      applicationId: requiredString(payload.application_id),
      tenantId: requiredString(payload.tenant_id),
      sessionId: requiredString(payload.session_id),
    };
    const issuedAt = requiredNumber(payload.iat);
    const expiresAt = requiredNumber(payload.exp);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > SANDBOX_CONTROL_TOKEN_TTL_SECONDS) throw new SandboxControlTokenError();
    if (payload.sub !== `sandbox-session:${claim.sessionId}`
      || scope.sessionId !== claim.sessionId
      || payload.workspace_id !== claim.workspaceId
      || payload.generation !== claim.generation
      || !safeEqual(requiredString(payload.claim_sha256), sandboxClaimBodyHash(claim))) {
      throw new SandboxControlTokenError();
    }
    assertScopeMatchesClaim(scope, claim);
    return {
      ...scope,
      jti: requiredString(payload.jti),
      expiresAt: new Date(expiresAt * 1_000),
    };
  } catch {
    throw new SandboxControlTokenError();
  }
}

export function assertSandboxControlKey(controlKey: string): void {
  if (Buffer.byteLength(controlKey, "utf8") < MINIMUM_CONTROL_KEY_BYTES) {
    throw new Error(`Sandbox control key must contain at least ${MINIMUM_CONTROL_KEY_BYTES} bytes`);
  }
}

export function sandboxClaimBodyHash(claimInput: SandboxSessionClaim): string {
  const claim = SandboxSessionClaimSchema.parse(claimInput);
  return createHash("sha256").update(canonicalJson(claim)).digest("hex");
}

function sandboxControlKey(controlKey: string): Uint8Array {
  assertSandboxControlKey(controlKey);
  return new TextEncoder().encode(controlKey);
}

function assertScopeMatchesClaim(scope: SandboxLeaseScope, claim: SandboxSessionClaim): void {
  if (!scope.applicationId.trim() || !scope.tenantId.trim() || !scope.sessionId.trim()
    || scope.sessionId !== claim.sessionId
    || workspaceId(scope) !== claim.workspaceId
    || (claim.repositoryCacheNamespace !== undefined && repositoryCacheNamespace(scope) !== claim.repositoryCacheNamespace)) {
    throw new SandboxControlTokenError();
  }
}

function workspaceId(scope: SandboxLeaseScope): string {
  return createHash("sha256")
    .update(scope.applicationId).update("\0")
    .update(scope.tenantId).update("\0")
    .update(scope.sessionId)
    .digest("hex");
}

function repositoryCacheNamespace(scope: SandboxLeaseScope): string {
  return createHash("sha256")
    .update(scope.applicationId).update("\0")
    .update(scope.tenantId)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new SandboxControlTokenError();
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new SandboxControlTokenError();
  return value;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
