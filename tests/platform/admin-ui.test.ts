import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAdminUiApplication, assertSameOrigin, listVisibleApplicationManifests } from "../../src/platform/admin-ui/application.ts";
import { loadAdminUiHtml, resolveAdminUiHtmlPath } from "../../src/platform/admin-ui/shell.ts";
import { InMemoryAuditLog } from "../../src/platform/auth/audit-log.ts";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";
import { GoogleOidcService } from "../../src/platform/auth/google-oidc.ts";
import { canRunQaseyTask } from "../../apps/admin-ui/src/catalog.ts";
import { InMemorySlackInstallationRepository } from "../../src/platform/channels/slack-installation-repository.ts";
import { SlackIntegrationManager } from "../../src/platform/channels/slack-integration-manager.ts";
import { TriggerProviderRegistry } from "../../src/platform/triggers/trigger-provider-registry.ts";
import { SlackTriggerProvider } from "../../src/platform/triggers/slack-trigger-provider.ts";

const googleOidc = new GoogleOidcService({ callbackUrl: "http://localhost:4111/auth/google/callback", secureCookies: false });

describe("same-origin Admin UI", () => {
  it("detects the workflow-backed Qasey task ingress without depending on its qualified route ID", () => {
    expect(canRunQaseyTask([{
      applicationId: "qasey",
      resourceType: "route",
      resourceId: "qasey-qasey-task",
      routePath: "/v1/qasey/tasks",
      routeMethod: "POST",
      permission: "qasey.agent.execute",
    }])).toBe(true);

    expect(canRunQaseyTask([{
      applicationId: "qasey",
      resourceType: "workflow",
      resourceId: "qasey-task",
      permission: "qasey.task.execute",
    }])).toBe(false);
  });

  it("exposes metadata BFF routes while execution goes through domain-safe handlers", async () => {
    const app = createAdminUiApplication({ publicBaseUrl: "https://runtime.test", applicationCatalog: [], permissions: new PermissionService(new InMemoryPermissionStore()), audit: new InMemoryAuditLog(), googleOidc });
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
    expect(adminUiHtml).not.toContain("/studio/api/agents/");
    expect(adminUiHtml).toContain("/v1/runs");
    expect(adminUiHtml).not.toContain("/studio/api/workflows/");
    expect(adminUiHtml).toContain("/v1/qasey/tasks");
    expect(app.routes?.find(route => route.id === "audit")?.access.permission).toBe("platform.audit.read");
  });

  it("requires a same-origin browser mutation request", () => {
    expect(() => assertSameOrigin(new Request("http://internal:8080/admin/api/permissions/grants", { headers: { origin: "https://runtime.test" } }), "https://runtime.test/app")).not.toThrow();
    expect(() => assertSameOrigin(new Request("http://internal:8080/admin/api/permissions/grants", { headers: { origin: "https://evil.test" } }), "https://runtime.test")).toThrow(/CSRF/u);
    expect(() => assertSameOrigin(new Request("http://internal:8080/admin/api/permissions/grants"), "https://runtime.test")).toThrow(/CSRF/u);
    expect(() => assertSameOrigin(new Request("http://internal:8080/admin/api/permissions/grants", { headers: { origin: "not-an-origin" } }), "https://runtime.test")).toThrow(/CSRF/u);
  });

  it("exposes provider-neutral Trigger management routes only when configured", () => {
    const slackIntegrations = new SlackIntegrationManager(
      new InMemorySlackInstallationRepository("test-key"),
      "https://qasey.example.com",
      [{ applicationId: "qasey", agentId: "qasey-main", name: "Qasey" }],
      { verify: async () => ({ appId: "A1", teamId: "T1", botUserId: "U1" }) },
    );
    const triggerProviders = new TriggerProviderRegistry([new SlackTriggerProvider(slackIntegrations)]);
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [], permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(), googleOidc, triggerProviders,
    });
    const routes = app.routes ?? [];
    expect(routes.find(route => route.id === "trigger-connections")?.access.permission).toBe("platform.triggers.read");
    expect(routes.find(route => route.id === "trigger-create")?.access.permission).toBe("platform.triggers.manage");
    expect(routes.map(route => `${route.route.method} ${route.route.path}`)).toContain("POST /admin/api/triggers/connections/:providerId/:id/rebind");
    expect(routes.map(route => `${route.route.method} ${route.route.path}`)).toContain("DELETE /admin/api/triggers/connections/:providerId/:id");
  });

  it("returns 403 instead of 500 when a Trigger mutation fails the origin check", async () => {
    const slackIntegrations = new SlackIntegrationManager(
      new InMemorySlackInstallationRepository("test-key"),
      "https://qasey.example.com",
      [{ applicationId: "qasey", agentId: "qasey-main", name: "Qasey" }],
      { verify: async () => ({ appId: "A1", teamId: "T1", botUserId: "U1" }) },
    );
    const triggerProviders = new TriggerProviderRegistry([new SlackTriggerProvider(slackIntegrations)]);
    const create = vi.spyOn(triggerProviders, "create");
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [], permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(), googleOidc, triggerProviders,
    });
    const route = app.routes?.find(candidate => candidate.id === "trigger-create")?.route;
    expect(route && "handler" in route).toBe(true);
    if (!route || !("handler" in route)) throw new Error("trigger-create handler is missing");
    const handler = route.handler as unknown as (context: any) => Promise<Response>;

    const response = await handler({
      req: {
        raw: new Request("http://internal:8080/admin/api/triggers/connections", {
          method: "POST",
          headers: { origin: "https://evil.test" },
        }),
      },
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden", message: "请求来源验证失败。" });
    expect(create).not.toHaveBeenCalled();
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
