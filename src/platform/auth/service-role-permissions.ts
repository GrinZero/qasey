import type { PermissionService } from "./permission-store.ts";

export const SERVICE_ROLE_PERMISSIONS = {
  "qasey-ingress": ["qasey.channel.receive"],
  "orchestration-worker": ["platform.workflow-events.receive", "qasey.e2e.execute", "qasey.case-workflow.execute"],
  "platform-service": [
    "platform.catalog.read",
    "platform.runtime.inspect",
    "qasey.agent.execute",
    "qasey.e2e.execute",
    "qasey.runs.read",
    "qasey.runs.write",
  ],
} as const;

export type ServiceRole = keyof typeof SERVICE_ROLE_PERMISSIONS;

export interface ServiceRoleGrant {
  tenantId: string;
  role: ServiceRole;
  permissions: readonly string[];
}

export function serviceRoleGrants(jiraBaseUrl?: string): readonly ServiceRoleGrant[] {
  const jiraTenantId = jiraBaseUrl ? new URL(jiraBaseUrl).hostname : "trusted-ingress";
  return (Object.entries(SERVICE_ROLE_PERMISSIONS) as [ServiceRole, readonly string[]][]).map(([role, permissions]) => ({
    tenantId: role === "qasey-ingress" ? jiraTenantId : "trusted-ingress",
    role,
    permissions,
  }));
}

/** Seed trusted service roles before the server accepts traffic. */
export async function seedServiceRolePermissions(
  permissionService: PermissionService,
  jiraBaseUrl?: string,
): Promise<void> {
  await Promise.all(serviceRoleGrants(jiraBaseUrl).map(({ tenantId, role, permissions }) =>
    permissionService.grantRolePermissions(tenantId, role, permissions),
  ));
}
