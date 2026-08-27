import type { PermissionService } from "./permission-store.ts";

export const SERVICE_ROLE_PERMISSIONS = {
  "qasey-ingress": ["qasey.channel.receive"],
  "orchestration-worker": ["platform.workflow-events.receive", "qasey.e2e.execute", "qasey.case-workflow.execute"],
  "platform-service": [
    "platform.catalog.read",
    "platform.metrics.read",
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

export function serviceRoleGrants(tenantId = "trusted-ingress"): readonly ServiceRoleGrant[] {
  return (Object.entries(SERVICE_ROLE_PERMISSIONS) as [ServiceRole, readonly string[]][]).map(([role, permissions]) => ({
    tenantId,
    role,
    permissions,
  }));
}

/** Seed trusted service roles before the server accepts traffic. */
export async function seedServiceRolePermissions(
  permissionService: PermissionService,
  tenantId?: string,
): Promise<void> {
  await Promise.all(serviceRoleGrants(tenantId).map(({ tenantId, role, permissions }) =>
    permissionService.grantRolePermissions(tenantId, role, permissions),
  ));
}
