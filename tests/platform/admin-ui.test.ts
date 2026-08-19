import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAdminUiApplication, assertSameOrigin, listVisibleApplicationManifests } from "../../src/platform/admin-ui/application.ts";
import { loadAdminUiHtml, resolveAdminUiHtmlPath } from "../../src/platform/admin-ui/shell.ts";
import { InMemoryAuditLog } from "../../src/platform/auth/audit-log.ts";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";
import { GoogleOidcService } from "../../src/platform/auth/google-oidc.ts";

const googleOidc = new GoogleOidcService({ callbackUrl: "http://localhost:4111/auth/google/callback", secureCookies: false });

describe("same-origin Admin UI", () => {
  it("exposes metadata BFF routes while execution goes through domain-safe handlers", async () => {
    const app = createAdminUiApplication({ applicationCatalog: [], permissions: new PermissionService(new InMemoryPermissionStore()), audit: new InMemoryAuditLog(), googleOidc });
    expect(app.routes?.map(route => route.route.path)).toEqual([
      "/admin", "/auth/google/login", "/auth/google/callback", "/auth/logout", "/admin/api/session", "/admin/api/catalog", "/admin/api/applications", "/admin/api/audit", "/admin/api/permissions/grants", "/admin/api/permissions/bindings",
    ]);
    expect(app.routes?.find(route => route.id === "shell")?.access.permission).toBe("platform.admin-ui.access");
    expect(app.routes?.find(route => route.id === "shell")?.public).toBe(true);
    expect(app.routes?.find(route => route.id === "shell")?.route.requiresAuth).toBe(false);
    expect(app.routes?.filter(route => route.id === "google-login" || route.id === "google-callback" || route.id === "logout").every(route => route.public && route.route.requiresAuth === false)).toBe(true);
    expect(app.routes?.find(route => route.id === "permission-grant")?.access.permission).toBe("platform.permissions.manage");
    const adminUiHtml = await loadAdminUiHtml();
    expect(adminUiHtml).toContain("Qasey");
    expect(adminUiHtml).toContain("/studio/api/agents/");
    expect(adminUiHtml).toContain("/v1/runs");
    expect(adminUiHtml).not.toContain("/studio/api/workflows/");
    expect(adminUiHtml).not.toContain("/v1/qasey");
    expect(app.routes?.find(route => route.id === "audit")?.access.permission).toBe("platform.audit.read");
  });

  it("requires a same-origin browser mutation request", () => {
    expect(() => assertSameOrigin(new Request("https://runtime.test/admin/api/permissions/grants", { headers: { origin: "https://runtime.test" } }))).not.toThrow();
    expect(() => assertSameOrigin(new Request("https://runtime.test/admin/api/permissions/grants", { headers: { origin: "https://evil.test" } }))).toThrow(/CSRF/u);
    expect(() => assertSameOrigin(new Request("https://runtime.test/admin/api/permissions/grants"))).toThrow(/CSRF/u);
  });

  it.each(["src/mastra/public", ".mastra/output"])("finds the Admin UI target from %s", async workingDirectory => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "qasey-admin-ui-"));
    const mastraWorkingDirectory = resolve(repositoryRoot, workingDirectory);
    try {
      await mkdir(mastraWorkingDirectory, { recursive: true });
      await mkdir(resolve(repositoryRoot, "apps/admin-ui"), { recursive: true });
      expect(resolveAdminUiHtmlPath(mastraWorkingDirectory)).toBe(
        resolve(repositoryRoot, "apps/admin-ui/dist/index.html"),
      );
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("only lists Agent Applications the current user can access", async () => {
    const store = new InMemoryPermissionStore();
    store.grant("tenant-1", "qa", "qasey.agent.execute");
    const permissions = new PermissionService(store);
    const applications = [
      { id: "qasey", ui: { name: "Qasey", description: "QA", category: "Quality", capabilities: ["Review"], homePath: "/admin#apps/qasey", accent: "indigo" as const } },
      { id: "code-review", ui: { name: "Code Review", description: "Review", category: "Engineering", capabilities: ["Review"], homePath: "/admin#apps/code-review", accent: "teal" as const } },
    ];
    const visible = await listVisibleApplicationManifests({
      applications,
      applicationCatalog: [
        { applicationId: "qasey", resourceType: "agent", resourceId: "qasey-main", permission: "qasey.agent.execute", audiences: ["admin-ui"] },
        { applicationId: "code-review", resourceType: "agent", resourceId: "review-main", permission: "review.agent.execute", audiences: ["admin-ui"] },
      ],
      permissions,
      principal: { subjectId: "user-1", tenantId: "tenant-1", roles: ["qa"], audience: "admin-ui", service: false },
    });
    expect(visible.map(application => application.id)).toEqual(["qasey"]);
  });
});
