import { describe, expect, it, vi } from "vitest";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";
import { SERVICE_ROLE_PERMISSIONS, seedServiceRolePermissions, serviceRoleGrants } from "../../src/platform/auth/service-role-permissions.ts";
import { createServicePrincipal } from "../../src/platform/auth/oauth-principal.ts";

describe("service role permissions", () => {
  it("maps Jira to its installation tenant and keeps internal services isolated", () => {
    expect(serviceRoleGrants("https://example.atlassian.net/jira")).toEqual([
      { tenantId: "example.atlassian.net", role: "qasey-ingress", permissions: SERVICE_ROLE_PERMISSIONS["qasey-ingress"] },
      { tenantId: "trusted-ingress", role: "orchestration-worker", permissions: SERVICE_ROLE_PERMISSIONS["orchestration-worker"] },
      { tenantId: "trusted-ingress", role: "platform-service", permissions: SERVICE_ROLE_PERMISSIONS["platform-service"] },
    ]);
  });

  it("seeds each service role once as a batch before requests are authorized", async () => {
    const store = new InMemoryPermissionStore();
    const batch = vi.spyOn(store, "grantRolePermissions");
    const permissions = new PermissionService(store);

    await seedServiceRolePermissions(permissions, "https://example.atlassian.net");

    expect(batch).toHaveBeenCalledTimes(3);
    await expect(permissions.authorize({
      principal: createServicePrincipal({
        subjectId: "platform-service",
        tenantId: "trusted-ingress",
        roles: ["platform-service"],
      }),
      applicationId: "qasey",
      resourceType: "agent",
      resourceId: "qasey-main",
      action: "execute",
      permission: "qasey.agent.execute",
    })).resolves.toBe(true);
  });
});
