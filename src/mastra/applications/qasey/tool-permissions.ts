import type { RequestContext } from "@mastra/core/request-context";
import type { PermissionService } from "../../../platform/auth/permission-store.ts";
import { OAuthPrincipalSchema } from "../../../platform/auth/oauth-principal.ts";
import { ownerScopeFromRequestContext } from "../../../platform/context/owner-scope.ts";

let permissions: PermissionService | undefined;
export function configureQaseyToolPermissions(service: PermissionService): void { permissions = service; }

/** Tools enforce permissions themselves: a plain chat is not an E2E authorization grant. */
export async function requireQaseyToolPermission(context: RequestContext<any>, permission: string): Promise<void> {
  const principal = OAuthPrincipalSchema.safeParse(context.get("platform-principal"));
  const owner = ownerScopeFromRequestContext(context);
  if (!permissions || !principal.success || principal.data.tenantId !== owner.tenantId
    || !await permissions.authorize({ principal: principal.data, applicationId: owner.applicationId,
      resourceType: "agent", resourceId: "qasey-main", action: "execute", permission })) {
    throw new Error(`Tool permission required: ${permission}`);
  }
}
