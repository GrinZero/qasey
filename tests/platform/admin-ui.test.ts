import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAdminUiApplication, assertSameOrigin, availableApiTokenScopes, listVisibleApplicationManifests } from "../../src/platform/admin-ui/application.ts";
import { loadAdminUiHtml, resolveAdminUiHtmlPath } from "../../src/platform/admin-ui/shell.ts";
import { InMemoryAuditLog } from "../../src/platform/auth/audit-log.ts";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";
import { GoogleOidcService } from "../../src/platform/auth/google-oidc.ts";
import { PasswordAuthService } from "../../src/platform/auth/password-auth.ts";
import { canRunQaseyTask } from "../../apps/admin-ui/src/catalog.ts";
import { adminPaths, legacyAdminPath, viewForAdminPath } from "../../apps/admin-ui/src/routes.ts";
import { InMemorySlackInstallationRepository } from "../../src/platform/channels/slack-installation-repository.ts";
import { SlackIntegrationManager } from "../../src/platform/channels/slack-integration-manager.ts";
import { TriggerProviderRegistry } from "../../src/platform/triggers/trigger-provider-registry.ts";
import { SlackTriggerProvider } from "../../src/platform/triggers/slack-trigger-provider.ts";
import { InMemoryApiTokenStore } from "../../src/platform/auth/api-token-store.ts";
import { InMemoryOrganizationStore } from "../../src/platform/auth/organization-store.ts";
import { InMemoryExternalConnectionStore } from "../../src/platform/connections/connection-store.ts";
import { InMemoryFailureInboxStore } from "../../src/platform/recovery/failure-inbox.ts";
import { freezeE2EContext, InMemoryRunRepository } from "../../packages/domain/src/index.ts";
import type { E2ERun, OwnerScope } from "../../packages/contracts/src/index.ts";

const googleOidc = new GoogleOidcService({
  callbackUrl: "http://localhost:4111/auth/google/callback",
  secureCookies: false,
  organizationStore: new InMemoryOrganizationStore(),
  tenancy: { mode: "single", organizationId: "local" },
});

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
      "/admin", "/auth/config", "/auth/google/login", "/auth/google/callback", "/auth/organization-selection", "/auth/organization-selection", "/auth/logout", "/admin/api/session", "/admin/api/catalog", "/admin/api/applications", "/admin/api/audit", "/admin/api/permissions/grants", "/admin/api/permissions/bindings",
      "/admin/*",
    ]);
    expect(app.routes?.find(route => route.id === "shell")?.access.permission).toBe("platform.admin-ui.access");
    expect(app.routes?.find(route => route.id === "shell")?.public).toBe(true);
    expect(app.routes?.find(route => route.id === "shell")?.route.requiresAuth).toBe(false);
    expect(app.routes?.filter(route => route.id === "auth-config"
      || route.id === "google-login"
      || route.id === "google-callback"
      || route.id.startsWith("organization-selection")
      || route.id === "logout").every(route => route.public && route.route.requiresAuth === false)).toBe(true);
    expect(app.routes?.find(route => route.id === "permission-grant")?.access.permission).toBe("platform.permissions.manage");
    const adminUiHtml = await loadAdminUiHtml();
    expect(adminUiHtml).toContain("Qasey");
    expect(adminUiHtml).not.toContain("/studio/api/agents/");
    expect(adminUiHtml).toContain("/v1/runs");
    expect(adminUiHtml).not.toContain("/studio/api/workflows/");
    expect(adminUiHtml).toContain("/v1/qasey/tasks");
    expect(app.routes?.find(route => route.id === "audit")?.access.permission).toBe("platform.audit.read");
  });

  it("publishes no-store authentication capabilities without requiring a session", async () => {
    const passwordAuth = await passwordAuthFixture();
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(),
      googleOidc,
      passwordAuth,
    });
    const route = app.routes?.find(candidate => candidate.id === "auth-config")?.route;
    if (!route || !("handler" in route)) throw new Error("auth-config handler is missing");
    const headers: string[] = [];

    const response = await (route.handler as any)({
      header: (name: string, value: string) => headers.push(`${name}:${value}`),
      json: jsonResponse,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ google: false, password: true, registration: true });
    expect(headers).toContain("cache-control:no-store");
    expect(route.requiresAuth).toBe(false);
  });

  it("enforces same-origin password requests and maps registration and login outcomes to bounded responses", async () => {
    const passwordAuth = await passwordAuthFixture();
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(),
      googleOidc,
      passwordAuth,
    });

    const crossOrigin = await invokePasswordRoute(app, "password-register", {
      email: "member@example.invalid",
      password: "synthetic-password-phrase",
    }, "https://attacker.example.invalid");
    expect(crossOrigin.response.status).toBe(403);
    await expect(crossOrigin.response.json()).resolves.toMatchObject({ error: "forbidden" });

    const shortRegistration = await invokePasswordRoute(app, "password-register", {
      email: "short@example.invalid",
      password: "123456789",
    });
    expect(shortRegistration.response.status).toBe(400);
    await expect(shortRegistration.response.json()).resolves.toEqual({
      error: "invalid_input",
      message: "请输入有效邮箱和 10–128 位密码。",
    });

    const registered = await invokePasswordRoute(app, "password-register", {
      email: "Member@Example.Invalid",
      password: "synthetic-password-phrase",
      displayName: "Synthetic Member",
      redirectUri: "https://attacker.example.invalid/steal",
    });
    expect(registered.response.status).toBe(201);
    await expect(registered.response.json()).resolves.toEqual({ redirectTo: "/admin" });
    expect(registered.headers).toContain("cache-control:no-store");
    expect(registered.headers.filter(header => header.startsWith("set-cookie:"))).toHaveLength(3);
    expect(registered.headers).toContainEqual(expect.stringMatching(
      /^set-cookie:qasey_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/u,
    ));

    const duplicate = await invokePasswordRoute(app, "password-register", {
      email: "member@example.invalid",
      password: "synthetic-password-phrase",
    });
    expect(duplicate.response.status).toBe(409);
    await expect(duplicate.response.json()).resolves.toMatchObject({ error: "account_exists" });

    const wrongPassword = await invokePasswordRoute(app, "password-login", {
      email: "member@example.invalid",
      password: "wrong-synthetic-password",
    });
    expect(wrongPassword.response.status).toBe(401);
    await expect(wrongPassword.response.json()).resolves.toEqual({
      error: "invalid_credentials",
      message: "邮箱或密码不正确。",
    });
    expect(wrongPassword.headers.some(header => header.startsWith("set-cookie:"))).toBe(false);

    const shortPassword = await invokePasswordRoute(app, "password-login", {
      email: "member@example.invalid",
      password: "short",
    });
    expect(shortPassword.response.status).toBe(401);
    await expect(shortPassword.response.json()).resolves.toEqual({
      error: "invalid_credentials",
      message: "邮箱或密码不正确。",
    });

    const loggedIn = await invokePasswordRoute(app, "password-login", {
      email: "member@example.invalid",
      password: "synthetic-password-phrase",
      redirectUri: "/admin/apps/qasey?tab=runs",
    });
    expect(loggedIn.response.status).toBe(200);
    await expect(loggedIn.response.json()).resolves.toEqual({ redirectTo: "/admin/apps/qasey?tab=runs" });
    expect(loggedIn.headers.filter(header => header.startsWith("set-cookie:"))).toHaveLength(3);
  });

  it("revokes the presented browser session before clearing the logout cookie", async () => {
    const revokeCurrentSession = vi.spyOn(googleOidc, "revokeCurrentSession").mockResolvedValue(true);
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(),
      googleOidc,
    });
    const route = app.routes?.find(candidate => candidate.id === "logout")?.route;
    if (!route || !("handler" in route)) throw new Error("logout handler is missing");
    const request = new Request("https://runtime.test/auth/logout", {
      method: "POST",
      headers: { origin: "https://runtime.test", cookie: "qasey_session=opaque-token" },
    });
    const headers: string[] = [];

    const response = await (route.handler as any)({
      req: { raw: request },
      header: (name: string, value: string) => headers.push(`${name}:${value}`),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });

    expect(response.status).toBe(200);
    expect(revokeCurrentSession).toHaveBeenCalledWith(request);
    expect(headers).toContainEqual(expect.stringContaining("set-cookie:qasey_session=;"));
    revokeCurrentSession.mockRestore();
  });

  it("exposes only sealed organization candidates and rejects forged selection identity fields", async () => {
    const readSelection = vi.spyOn(googleOidc, "getOrganizationSelection").mockResolvedValue({
      redirectTo: "/admin/apps/qasey",
      organizations: [
        { id: "tenant-alpha", displayName: "Alpha" },
        { id: "tenant-beta", displayName: "Beta" },
      ],
    });
    const completeSelection = vi.spyOn(googleOidc, "completeOrganizationSelection").mockResolvedValue({
      redirectTo: "/admin/apps/qasey",
      cookies: [
        "qasey_session=opaque; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
        googleOidc.clearOrganizationSelectionCookie(),
      ],
    });
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(),
      googleOidc,
    });
    const getRoute = app.routes?.find(route => route.id === "organization-selection")?.route;
    const postRoute = app.routes?.find(route => route.id === "organization-selection-complete")?.route;
    if (!getRoute || !("handler" in getRoute) || !postRoute || !("handler" in postRoute)) {
      throw new Error("organization selection routes are missing");
    }
    const getRequest = new Request("https://runtime.test/auth/organization-selection", {
      headers: { cookie: "qasey_organization_selection=sealed" },
    });
    const getResponse = await (getRoute.handler as any)({
      req: { raw: getRequest },
      header: () => undefined,
      json: jsonResponse,
    });
    const selectionBody = await getResponse.json();
    expect(selectionBody).toEqual({
      selection: {
        redirectTo: "/admin/apps/qasey",
        organizations: [
          { id: "tenant-alpha", displayName: "Alpha" },
          { id: "tenant-beta", displayName: "Beta" },
        ],
      },
    });
    expect(readSelection).toHaveBeenCalledWith(getRequest);
    expect(JSON.stringify(selectionBody)).not.toContain("userId");

    const forgedRequest = new Request("https://runtime.test/auth/organization-selection", {
      method: "POST",
      headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "tenant-alpha", userId: "forged-user", tenantId: "tenant-gamma" }),
    });
    const forgedResponse = await (postRoute.handler as any)({
      req: { raw: forgedRequest, json: () => forgedRequest.clone().json() },
      header: () => undefined,
      json: jsonResponse,
    });
    expect(forgedResponse.status).toBe(400);
    expect(completeSelection).not.toHaveBeenCalled();

    const crossOriginRequest = new Request("https://runtime.test/auth/organization-selection", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "tenant-alpha" }),
    });
    const crossOriginResponse = await (postRoute.handler as any)({
      req: { raw: crossOriginRequest, json: () => crossOriginRequest.clone().json() },
      header: () => undefined,
      json: jsonResponse,
    });
    expect(crossOriginResponse.status).toBe(403);
    expect(completeSelection).not.toHaveBeenCalled();

    const validRequest = new Request("https://runtime.test/auth/organization-selection", {
      method: "POST",
      headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "tenant-beta" }),
    });
    const headers: string[] = [];
    const validResponse = await (postRoute.handler as any)({
      req: { raw: validRequest, json: () => validRequest.clone().json() },
      header: (name: string, value: string) => headers.push(`${name}:${value}`),
      json: jsonResponse,
    });
    expect(validResponse.status).toBe(200);
    await expect(validResponse.json()).resolves.toEqual({ redirectTo: "/admin/apps/qasey" });
    expect(completeSelection).toHaveBeenCalledWith(validRequest, "tenant-beta");
    expect(headers.filter(header => header.startsWith("set-cookie:"))).toHaveLength(2);

    readSelection.mockRestore();
    completeSelection.mockRestore();
  });

  it("maps stable Admin UI URLs and migrates the legacy Qasey hash", () => {
    expect(viewForAdminPath("/admin/triggers")).toBe("triggers");
    expect(viewForAdminPath("/admin/apps/qasey/runs/")).toBe("qasey-runs");
    expect(viewForAdminPath("/admin/unknown")).toBeUndefined();
    expect(legacyAdminPath("/admin", "#apps/qasey")).toBe(adminPaths["qasey-overview"]);
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
    expect(routes.map(route => `${route.route.method} ${route.route.path}`)).toContain("POST /admin/api/triggers/connections/:providerId/:id/rotate");
    expect(routes.map(route => `${route.route.method} ${route.route.path}`)).toContain("POST /admin/api/triggers/connections/:providerId/:id/rebind");
    expect(routes.map(route => `${route.route.method} ${route.route.path}`)).toContain("DELETE /admin/api/triggers/connections/:providerId/:id");
  });

  it("exposes tenant API Token lifecycle routes with read-only Studio scopes and filtered application scopes", () => {
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [
        { applicationId: "qasey", resourceType: "route", resourceId: "read", permission: "qasey.runs.read", audiences: ["admin-ui", "api"] },
        { applicationId: "qasey", resourceType: "workflow", resourceId: "task", permission: "qasey.task.execute", audiences: ["api"] },
        { applicationId: "qasey", resourceType: "workflow", resourceId: "e2e", permission: "qasey.e2e.execute", audiences: ["api"] },
        { applicationId: "qasey", resourceType: "workflow", resourceId: "case", permission: "qasey.case-workflow.execute", audiences: ["api"] },
        { applicationId: "qasey", resourceType: "scorer", resourceId: "quality", permission: "qasey.scorers.read", audiences: ["api"] },
        { applicationId: "qasey", resourceType: "agent", resourceId: "main", permission: "qasey.agent.execute", audiences: ["api"] },
        { applicationId: "platform", resourceType: "route", resourceId: "manage", permission: "platform.runtime.manage", audiences: ["api"] },
      ],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(), googleOidc, apiTokens: new InMemoryApiTokenStore(),
    });
    expect(app.routes?.map(route => `${route.route.method} ${route.route.path}`)).toEqual(expect.arrayContaining([
      "GET /admin/api/tokens", "POST /admin/api/tokens", "DELETE /admin/api/tokens/:tokenId",
    ]));
    expect(app.routes?.filter(route => route.id.startsWith("api-token-")).every(route =>
      route.access.permission === "platform.api-tokens.manage" && route.access.audiences.includes("admin-ui"),
    )).toBe(true);
    expect(availableApiTokenScopes(app.routes ? [
      { applicationId: "qasey", resourceType: "route", resourceId: "read", permission: "qasey.runs.read", audiences: ["admin-ui", "api"] },
      { applicationId: "qasey", resourceType: "workflow", resourceId: "task", permission: "qasey.task.execute", audiences: ["api"] },
      { applicationId: "qasey", resourceType: "workflow", resourceId: "e2e", permission: "qasey.e2e.execute", audiences: ["api"] },
      { applicationId: "qasey", resourceType: "workflow", resourceId: "case", permission: "qasey.case-workflow.execute", audiences: ["api"] },
      { applicationId: "qasey", resourceType: "scorer", resourceId: "quality", permission: "qasey.scorers.read", audiences: ["api"] },
      { applicationId: "qasey", resourceType: "agent", resourceId: "main", permission: "qasey.agent.execute", audiences: ["api"] },
      { applicationId: "platform", resourceType: "route", resourceId: "manage", permission: "platform.runtime.manage", audiences: ["api"] },
    ] : [])).toEqual([
      "platform.background-tasks.read",
      "platform.catalog.read",
      "platform.internal-workflow.read",
      "platform.runtime.inspect",
      "platform.schedules.read",
      "qasey.agent.execute",
      "qasey.runs.read",
    ]);
  });

  it("creates and revokes an audited tenant API Token without returning its secret from the list", async () => {
    const apiTokens = new InMemoryApiTokenStore();
    const audit = new InMemoryAuditLog();
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [
        { applicationId: "qasey", resourceType: "route", resourceId: "read", permission: "qasey.runs.read", audiences: ["api"] },
      ],
      permissions: new PermissionService(new InMemoryPermissionStore()), audit, googleOidc, apiTokens,
    });
    const principal = { subjectId: "admin-1", tenantId: "tenant-1", roles: ["platform-admin"], audience: "admin-ui", service: false };
    const requestContext = { get: (key: string) => key === "platform-principal" ? principal : key === "requestId" ? "request-1" : undefined };
    const createRoute = app.routes?.find(route => route.id === "api-token-create")?.route;
    if (!createRoute || !("handler" in createRoute)) throw new Error("api-token-create handler is missing");
    const request = new Request("https://runtime.test/admin/api/tokens", {
      method: "POST", headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "Trace debugger", scopes: ["platform.runtime.inspect", "qasey.runs.read"] }),
    });
    const response = await (createRoute.handler as any)({
      req: { raw: request, json: () => request.clone().json() },
      get: (key: string) => key === "requestContext" ? requestContext : undefined,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });
    const created = await response.json() as { token: string; record: { id: string; scopes: string[] } };

    expect(response.status).toBe(201);
    expect(created.token).toMatch(/^qsy_/u);
    expect(created.record.scopes).toEqual(["platform.runtime.inspect", "qasey.runs.read"]);
    expect(await apiTokens.list("tenant-1")).toEqual([expect.not.objectContaining({ token: expect.anything() })]);
    expect(audit.records.at(-1)).toMatchObject({ resourceType: "api-token", action: "create", reason: "api_token_created" });

    const revokeRoute = app.routes?.find(route => route.id === "api-token-revoke")?.route;
    if (!revokeRoute || !("handler" in revokeRoute)) throw new Error("api-token-revoke handler is missing");
    const revokeRequest = new Request(`https://runtime.test/admin/api/tokens/${created.record.id}`, {
      method: "DELETE", headers: { origin: "https://runtime.test" },
    });
    const revokeResponse = await (revokeRoute.handler as any)({
      req: { raw: revokeRequest, param: () => created.record.id },
      get: (key: string) => key === "requestContext" ? requestContext : undefined,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });
    expect(revokeResponse.status).toBe(200);
    await expect(apiTokens.authenticate(created.token)).resolves.toBeUndefined();
    expect(audit.records.at(-1)).toMatchObject({ resourceType: "api-token", action: "revoke", reason: "api_token_revoked" });
  });

  it("manages tenant-scoped encrypted connections without returning credentials", async () => {
    const connections = new InMemoryExternalConnectionStore({
      activeKeyId: "current",
      keys: { current: "test-credential-encryption-key-at-least-32-bytes" },
    });
    const audit = new InMemoryAuditLog();
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit,
      googleOidc,
      externalConnections: connections,
    });
    const principal = { subjectId: "admin-a", tenantId: "tenant-a", roles: ["platform-admin"], audience: "admin-ui", service: false };
    const context = adminHandlerContext(principal);
    const route = app.routes?.find(candidate => candidate.id === "external-connection-create")?.route;
    if (!route || !("handler" in route)) throw new Error("external-connection-create handler is missing");
    const request = new Request("https://runtime.test/admin/api/connections", {
      method: "POST",
      headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({
        provider: "jira",
        name: "primary",
        configuration: { baseUrl: "https://jira.example.test" },
        credentials: { apiToken: "must-never-be-returned" },
      }),
    });

    const response = await (route.handler as any)({
      req: { raw: request, json: () => request.clone().json(), param: () => undefined },
      get: context.get,
      json: jsonResponse,
    });
    const body = await response.json() as { connection: { id: string; revision: number } };

    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toContain("must-never-be-returned");
    await expect(connections.list("tenant-b")).resolves.toEqual([]);
    expect(JSON.stringify(audit.records.at(-1))).not.toContain("must-never-be-returned");
    expect(app.routes?.find(candidate => candidate.id === "external-connection-revoke")?.access.permission)
      .toBe("platform.connections.manage");
  });

  it("provides an audited, owner-scoped failure inbox redrive endpoint", async () => {
    const owner: OwnerScope = { applicationId: "qasey", tenantId: "tenant-a" };
    const runs = new InMemoryRunRepository();
    const failures = new InMemoryFailureInboxStore();
    const failedRun = { ...adminFixtureRun(owner, "failed-run"), status: "failed" as const, error: "timeout" };
    await runs.create(owner, failedRun);
    const failure = await failures.record({
      ...owner,
      runId: failedRun.id,
      workflowId: "qasey-e2e-lifecycle",
      reasonCode: "heartbeat_timeout",
      errorCode: "RUN_HEARTBEAT_TIMEOUT",
      message: "timeout",
    });
    const createRedrive = vi.fn(async () => adminFixtureRun(owner, "redrive-run"));
    const audit = new InMemoryAuditLog();
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit,
      googleOidc,
      failureRecovery: { failures, runs, createRedrive },
    });
    const route = app.routes?.find(candidate => candidate.id === "failure-inbox-redrive")?.route;
    if (!route || !("handler" in route)) throw new Error("failure-inbox-redrive handler is missing");
    const request = new Request(`https://runtime.test/admin/api/failures/${failure.id}/redrive`, {
      method: "POST",
      headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({ revision: failure.revision }),
    });
    const context = adminHandlerContext({
      subjectId: "operator-a", tenantId: "tenant-a", roles: ["platform-admin"], audience: "admin-ui", service: false,
    });

    const response = await (route.handler as any)({
      req: { raw: request, json: () => request.clone().json(), param: () => failure.id },
      get: (key: string) => key === "mastra" ? {} : context.get(key),
      json: jsonResponse,
    });
    const body = await response.json() as { failure: { status: string; redriveRunId: string } };

    expect(response.status).toBe(202);
    expect(body.failure).toMatchObject({ status: "redriven", redriveRunId: "redrive-run" });
    expect(createRedrive).toHaveBeenCalledWith(
      owner,
      failedRun.id,
      expect.objectContaining({ actorId: "operator-a" }),
    );
    expect(audit.records.at(-1)).toMatchObject({ action: "redrive", reason: "operator_redrive" });
    expect(app.routes?.find(candidate => candidate.id === "failure-inbox-list")?.access.permission)
      .toBe("platform.failures.read");
  });

  it("invites and deprovisions members with session, token, and role revocation", async () => {
    const organizations = new InMemoryOrganizationStore();
    await organizations.createOrganization({ id: "tenant-a", slug: "tenant-a", displayName: "Tenant A" });
    const user = await organizations.createUser({ displayName: "Member" });
    const nonMember = await organizations.createUser({ displayName: "Non-member" });
    await organizations.linkIdentity({
      userId: user.id,
      provider: "google",
      subject: "google-member",
      email: "member@example.test",
      emailVerified: true,
    });
    await organizations.grantBootstrapMembership({ organizationId: "tenant-a", userId: user.id });
    const session = await organizations.createBrowserSession({
      organizationId: "tenant-a",
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const apiTokens = new InMemoryApiTokenStore();
    const token = await apiTokens.create({
      tenantId: "tenant-a", name: "member", scopes: ["qasey.runs.read"], createdBy: user.id,
    });
    const permissionStore = new InMemoryPermissionStore();
    const permissions = new PermissionService(permissionStore);
    await permissions.bindSubjectRole("tenant-a", user.id, "reviewer");
    const audit = new InMemoryAuditLog();
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions,
      audit,
      googleOidc,
      apiTokens,
      organizations,
    });
    const principal = { subjectId: "operator-a", tenantId: "tenant-a", roles: ["platform-admin"], audience: "admin-ui", service: false };
    const context = adminHandlerContext(principal);
    const inviteRoute = app.routes?.find(candidate => candidate.id === "organization-invitation-create")?.route;
    if (!inviteRoute || !("handler" in inviteRoute)) throw new Error("organization-invitation-create handler is missing");
    const inviteRequest = new Request("https://runtime.test/admin/api/organization/invitations", {
      method: "POST",
      headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({ email: "invited@example.test" }),
    });
    const inviteResponse = await (inviteRoute.handler as any)({
      req: { raw: inviteRequest, json: () => inviteRequest.clone().json() },
      get: context.get,
      json: jsonResponse,
    });
    expect(inviteResponse.status).toBe(201);
    expect(await organizations.listInvitations("tenant-a")).toEqual([
      expect.objectContaining({ email: "invited@example.test", status: "pending" }),
    ]);
    expect(JSON.stringify(audit.records.at(-1))).not.toContain("invited@example.test");

    const statusRoute = app.routes?.find(candidate => candidate.id === "organization-member-status")?.route;
    if (!statusRoute || !("handler" in statusRoute)) throw new Error("organization-member-status handler is missing");
    const nonMemberRequest = new Request(`https://runtime.test/admin/api/organization/members/${nonMember.id}`, {
      method: "PATCH",
      headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    const nonMemberResponse = await (statusRoute.handler as any)({
      req: { raw: nonMemberRequest, json: () => nonMemberRequest.clone().json(), param: () => nonMember.id },
      get: context.get,
      json: jsonResponse,
    });
    expect(nonMemberResponse.status).toBe(404);
    await expect(nonMemberResponse.json()).resolves.toEqual({ error: "organization_membership_not_found" });
    await expect(organizations.resolveMembership("tenant-a", nonMember.id)).resolves.toBeUndefined();

    const statusRequest = new Request(`https://runtime.test/admin/api/organization/members/${user.id}`, {
      method: "PATCH",
      headers: { origin: "https://runtime.test", "content-type": "application/json" },
      body: JSON.stringify({ status: "suspended" }),
    });
    const statusResponse = await (statusRoute.handler as any)({
      req: { raw: statusRequest, json: () => statusRequest.clone().json(), param: () => user.id },
      get: context.get,
      json: jsonResponse,
    });

    expect(statusResponse.status).toBe(200);
    await expect(organizations.authenticateBrowserSession(session.token)).resolves.toBeUndefined();
    await expect(apiTokens.authenticate(token.token)).resolves.toBeUndefined();
    await expect(permissionStore.rolesForSubject("tenant-a", user.id)).resolves.toEqual(new Set());
    await expect(organizations.resolveMembership("tenant-a", user.id)).resolves.toMatchObject({ status: "suspended" });
    expect(audit.records.at(-1)).toMatchObject({
      resourceType: "organization-membership",
      resourceId: user.id,
      action: "deprovision",
      metadata: { revokedTokens: 1, revokedRoles: 1 },
    });
  });

  it("returns a bounded 400 for malformed admin list filters", async () => {
    const app = createAdminUiApplication({
      publicBaseUrl: "https://runtime.test",
      applicationCatalog: [],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: new InMemoryAuditLog(),
      googleOidc,
      organizations: new InMemoryOrganizationStore(),
      externalConnections: new InMemoryExternalConnectionStore({
        activeKeyId: "default",
        keys: { default: "test-credential-encryption-key-at-least-32-bytes" },
      }),
      failureRecovery: {
        failures: new InMemoryFailureInboxStore(),
        runs: new InMemoryRunRepository(),
        createRedrive: async owner => adminFixtureRun(owner, "redrive"),
      },
    });
    const context = adminHandlerContext({
      subjectId: "operator-a", tenantId: "tenant-a", roles: ["platform-admin"], audience: "admin-ui", service: false,
    });
    const cases = [
      ["organization-members", { limit: "0" }],
      ["organization-invitations", { limit: "201" }],
      ["external-connection-list", { provider: "unknown" }],
      ["failure-inbox-list", { status: "unknown" }],
    ] as const;

    for (const [routeId, query] of cases) {
      const route = app.routes?.find(candidate => candidate.id === routeId)?.route;
      if (!route || !("handler" in route)) throw new Error(`${routeId} handler is missing`);
      const response = await (route.handler as any)({
        req: { query: (key: string) => query[key as keyof typeof query] },
        get: context.get,
        json: jsonResponse,
      });
      expect(response.status, routeId).toBe(400);
      await expect(response.clone().json()).resolves.toMatchObject({ error: "invalid_request" });
    }
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
      { id: "qasey", ui: { name: "Qasey", description: "QA", category: "Quality", capabilities: ["Review"], homePath: "/admin/apps/qasey", accent: "indigo" as const } },
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

function adminHandlerContext(principal: Record<string, unknown>): { get(key: string): unknown } {
  const requestContext = {
    get: (key: string) => key === "platform-principal" ? principal : key === "requestId" ? "request-1" : undefined,
  };
  return { get: (key: string) => key === "requestContext" ? requestContext : undefined };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function passwordAuthFixture(): Promise<PasswordAuthService> {
  const organizations = new InMemoryOrganizationStore({
    now: () => new Date("2026-08-27T08:00:00.000Z"),
  });
  await organizations.ensureOrganization({
    id: "tenant-password-ui",
    slug: "password-ui",
    displayName: "Password UI",
  });
  return new PasswordAuthService({
    enabled: true,
    registrationEnabled: true,
    organizationId: "tenant-password-ui",
    organizationStore: organizations,
    secureCookies: false,
    now: () => Date.parse("2026-08-27T08:00:00.000Z"),
    passwordHash: async password => `test-password-hash:${password}`,
    passwordVerify: async (password, encodedHash) => encodedHash === `test-password-hash:${password}`,
  });
}

async function invokePasswordRoute(
  app: ReturnType<typeof createAdminUiApplication>,
  routeId: "password-register" | "password-login",
  body: Record<string, unknown>,
  origin = "https://runtime.test",
): Promise<{ response: Response; headers: string[] }> {
  const route = app.routes?.find(candidate => candidate.id === routeId)?.route;
  if (!route || !("handler" in route)) throw new Error(`${routeId} handler is missing`);
  const path = routeId === "password-register" ? "/auth/password/register" : "/auth/password/login";
  const request = new Request(`https://runtime.test${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const headers: string[] = [];
  const response = await (route.handler as any)({
    req: { raw: request, json: () => request.clone().json() },
    header: (name: string, value: string) => headers.push(`${name}:${value}`),
    json: jsonResponse,
  });
  return { response, headers };
}

function adminFixtureRun(owner: OwnerScope, id: string): E2ERun {
  const at = "2026-08-26T00:00:00.000Z";
  const contextSnapshot = freezeE2EContext({
    goal: "test",
    requirementSummary: "test",
    inScope: [],
    outOfScope: [],
    confirmedDecisions: [],
    constraints: [],
    assumptions: [],
    criticalFlows: [],
    boundaryCases: [],
    negativeCases: [],
    testDataNeeds: [],
    repositoryFindings: [],
    blockingQuestions: [],
    evidenceRefs: [],
  }, {
    sessionId: "session",
    threadId: "thread",
    taskRunId: "task",
    requestId: "request",
    resourceId: "resource",
  });
  return {
    ...owner,
    id,
    requestId: "request",
    sourceSessionId: "session",
    status: "queued",
    revision: 1,
    platform: "web",
    framework: "playwright",
    repository: {
      owner: "example",
      repository: "web",
      cloneUrl: "https://github.com/example/web.git",
      baseRef: "main",
      allowedPaths: ["tests"],
      skillsPaths: [],
    },
    changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff",
    contextSnapshot,
    caseSnapshot: [],
    amendments: [],
    codeTaskIds: [],
    artifacts: [],
    createdAt: at,
    updatedAt: at,
  };
}
