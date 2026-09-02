import { timingSafeEqual } from "node:crypto";
import { OAuthPrincipalSchema, type OAuthPrincipal } from "./oauth-principal.ts";

export const DEVELOPMENT_AUTH_SUBJECT_ID = "local-developer";
export const DEVELOPMENT_AUTH_TENANT_ID = "local-development";

export interface DevelopmentPrincipalOptions {
  nodeEnv: "development" | "test" | "production";
  configuredToken: string | undefined;
  authorization: string | undefined;
  audience: "admin-ui" | "api";
}

/**
 * Resolves the opt-in local developer identity from a standard Bearer token.
 * The request only proves possession of the configured token; identity and
 * privileges remain server-owned constants.
 */
export function resolveDevelopmentPrincipal(options: DevelopmentPrincipalOptions): OAuthPrincipal | undefined {
  if (options.nodeEnv !== "development" || !options.configuredToken) return undefined;
  const presentedToken = bearerToken(options.authorization);
  if (!presentedToken || !tokensEqual(presentedToken, options.configuredToken)) return undefined;
  return OAuthPrincipalSchema.parse({
    subjectId: DEVELOPMENT_AUTH_SUBJECT_ID,
    tenantId: DEVELOPMENT_AUTH_TENANT_ID,
    roles: ["platform-admin"],
    audience: options.audience,
    service: false,
  });
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer[\t ]+([^\s]+)$/iu.exec(authorization?.trim() ?? "");
  return match?.[1];
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
