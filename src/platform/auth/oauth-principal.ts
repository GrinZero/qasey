import { z } from "zod";
import type { RuntimeAudience } from "../../runtime/application.ts";

export const OAuthPrincipalSchema = z.object({
  subjectId: z.string().min(1),
  tenantId: z.string().min(1),
  roles: z.array(z.string().min(1)),
  audience: z.enum(["admin-ui", "api", "service", "channel"]),
  email: z.email().optional(),
  service: z.boolean().default(false),
  scopes: z.array(z.string().min(1)).optional(),
  tokenId: z.uuid().optional(),
});

export type OAuthPrincipal = z.infer<typeof OAuthPrincipalSchema>;

export interface PrincipalMappingOptions<TUser> {
  subjectId(user: TUser): string;
  tenantId(user: TUser): string;
  roles(user: TUser): readonly string[];
  email?(user: TUser): string | undefined;
  audience?: RuntimeAudience;
}

/** OAuth user data is mapped only through server-owned functions. */
export function mapOAuthPrincipal<TUser>(user: TUser, options: PrincipalMappingOptions<TUser>): OAuthPrincipal {
  const email = options.email?.(user);
  return OAuthPrincipalSchema.parse({
    subjectId: options.subjectId(user),
    tenantId: options.tenantId(user),
    roles: [...options.roles(user)],
    audience: options.audience ?? "api",
    ...(email ? { email } : {}),
    service: false,
  });
}

export function createServicePrincipal(input: {
  subjectId: string;
  tenantId: string;
  roles: readonly string[];
}): OAuthPrincipal {
  return OAuthPrincipalSchema.parse({ ...input, roles: [...input.roles], audience: "service", service: true });
}
