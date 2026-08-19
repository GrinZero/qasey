import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import manifest from "../fixtures/mastra-route-permissions.json";
import type { CatalogEntry } from "../../src/runtime/application.ts";
import { classifyMastraStudioRoute, classifyRuntimeRoute, createAuthorizationMiddleware, isMastraStudioRequest, isPublicRuntimePath, resolveRequestUser } from "../../src/platform/auth/authorization-middleware.ts";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";
import { createServicePrincipal, OAuthPrincipalSchema } from "../../src/platform/auth/oauth-principal.ts";

const entries: CatalogEntry[] = [
  { applicationId: "alpha", resourceType: "agent", resourceId: "alpha-main", permission: "alpha.agent.execute", audiences: ["api", "channel"] },
  { applicationId: "alpha", resourceType: "workflow", resourceId: "alpha-job", permission: "alpha.workflow.execute", audiences: ["api"] },
  { applicationId: "alpha", resourceType: "scorer", resourceId: "alpha-quality", permission: "alpha.scorer.read", audiences: ["admin-ui"] },
  { applicationId: "alpha", resourceType: "channel", resourceId: "slack", permission: "alpha.channel.receive", audiences: ["channel"] },
  { applicationId: "alpha", resourceType: "protocol", resourceId: "alpha:conversations", permission: "alpha.agent.execute", audiences: ["admin-ui", "api", "service"] },
  { applicationId: "alpha", resourceType: "protocol", resourceId: "alpha:responses", permission: "alpha.agent.execute", audiences: ["admin-ui", "api", "service"] },
];

describe("permission route coverage", () => {
  it("protects Mastra Studio pages and recognizes its API client header", () => {
    expect(isPublicRuntimePath("/", "GET", true)).toBe(true);
    expect(isPublicRuntimePath("/", "GET", false)).toBe(false);
    expect(isPublicRuntimePath("/", "POST", true)).toBe(false);
    expect(isPublicRuntimePath("/healthz", "GET", false)).toBe(true);
    expect(classifyMastraStudioRoute("/studio", "GET")).toMatchObject({
      resourceId: "mastra-studio",
      permission: "platform.runtime.inspect",
      audiences: ["admin-ui"],
    });
    expect(classifyMastraStudioRoute("/studio/assets/index.js", "GET")).toBeDefined();
    expect(classifyMastraStudioRoute("/studio/agents/qasey-main/chat/new", "GET")).toBeDefined();
    expect(classifyMastraStudioRoute("/studio/api/agents", "GET")).toBeUndefined();
    expect(classifyMastraStudioRoute("/studio", "POST")).toBeUndefined();
    expect(classifyMastraStudioRoute("/admin", "GET")).toBeUndefined();
    expect(isMastraStudioRequest({ path: "/studio/api/agents", method: "GET", header: name => name === "x-mastra-client-type" ? "studio" : undefined })).toBe(true);
    expect(isMastraStudioRequest({
      path: "/studio/api/system/packages",
      method: "GET",
      header: name => name === "referer" ? "http://localhost:4111/studio/agents/qasey-main/chat/new" : undefined,
    })).toBe(true);
    expect(isMastraStudioRequest({
      path: "/studio/api/system/packages",
      method: "GET",
      header: name => name === "referer" ? "http://localhost:4111/admin" : undefined,
    })).toBe(false);
  });

  it("hydrates a verified session user before Mastra core auth populates request context", async () => {
    const values = new Map<string, unknown>();
    const requestContext = {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => { values.set(key, value); },
    };
    const raw = new Request("http://localhost:4111/admin/api/session");
    const verifiedUser = { id: "google-user", googleId: "google-user" };
    const provider = { getCurrentUser: async (request: Request) => request === raw ? verifiedUser : null };
    const isGoogleUser = (value: unknown): value is typeof verifiedUser =>
      typeof value === "object" && value !== null && "googleId" in value;

    await expect(resolveRequestUser(requestContext, { raw }, isGoogleUser, provider)).resolves.toBe(verifiedUser);
    expect(requestContext.get("user")).toBe(verifiedUser);
  });

  it.each([
    { audience: "admin-ui" as const, studio: true, expectedIngress: "mastra-studio" },
    { audience: "api" as const, studio: false, expectedIngress: "api" },
  ])("keeps $audience resource ownership without choosing a business thread", async ({ audience, studio, expectedIngress }) => {
    const requestContext = new RequestContext();
    const next = vi.fn(async () => undefined);
    const middleware = createAuthorizationMiddleware({
      catalog: [{ ...entries[0]!, audiences: [audience] }],
      permissions: { authorize: vi.fn(async () => true) } as unknown as PermissionService,
      audit: { write: vi.fn(async () => undefined) },
      studioUiEnabled: true,
      resolvePrincipal: () => OAuthPrincipalSchema.parse({
        subjectId: "user-1", tenantId: "tenant-1", roles: ["user"], audience,
      }),
    });
    const handler = middleware as Exclude<typeof middleware, { path: string }>;
    await handler({
      req: {
        path: "/studio/api/agents/alpha-main/stream",
        method: "POST",
        raw: new Request("http://localhost:4111/studio/api/agents/alpha-main/stream", { method: "POST" }),
        header: (name: string) => studio && name.toLowerCase() === "x-mastra-client-type" ? "studio" : undefined,
      },
      get: (key: string) => key === "requestContext" ? requestContext : undefined,
      json: vi.fn(),
    } as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe("alpha:tenant-1:user-1");
    expect(requestContext.get(MASTRA_THREAD_ID_KEY)).toBeUndefined();
    expect(requestContext.get("sessionId")).toBe("alpha:tenant-1:private:user-1");
    expect(requestContext.get("ingressSource")).toBe(expectedIngress);
  });

  it("uses the owning agent application across the Studio memory route surface", async () => {
    const middleware = createAuthorizationMiddleware({
      catalog: [{ ...entries[0]!, audiences: ["admin-ui"] }],
      permissions: { authorize: vi.fn(async () => true) } as unknown as PermissionService,
      audit: { write: vi.fn(async () => undefined) },
      studioUiEnabled: true,
      resolvePrincipal: () => OAuthPrincipalSchema.parse({
        subjectId: "user-1", tenantId: "tenant-1", roles: ["user"], audience: "admin-ui",
      }),
    });
    const handler = middleware as Exclude<typeof middleware, { path: string }>;
    const requests = [
      new Request("http://localhost:4111/studio/api/memory/threads?resourceId=alpha-main&agentId=alpha-main"),
      new Request("http://localhost:4111/studio/api/memory/threads/thread-1/messages?agentId=alpha-main&resourceId=alpha-main"),
      new Request("http://localhost:4111/studio/api/memory/observational-memory/buffer-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "alpha-main", resourceId: "alpha-main", threadId: "thread-1" }),
      }),
    ];

    for (const raw of requests) {
      const requestContext = new RequestContext();
      const next = vi.fn(async () => undefined);
      await handler({
        req: {
          path: new URL(raw.url).pathname,
          method: raw.method,
          raw,
          header: (name: string) => name.toLowerCase() === "x-mastra-client-type"
            ? "studio" : raw.headers.get(name) ?? undefined,
        },
        get: (key: string) => key === "requestContext" ? requestContext : undefined,
        json: vi.fn(),
      } as never, next);

      expect(next).toHaveBeenCalledOnce();
      expect(requestContext.get("applicationId")).toBe("alpha");
      expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe("alpha:tenant-1:user-1");
      expect(requestContext.get(MASTRA_THREAD_ID_KEY)).toBeUndefined();
    }
  });

  it("uses the workflow application scope for collection run counts", async () => {
    const middleware = createAuthorizationMiddleware({
      catalog: [{ ...entries[1]!, audiences: ["admin-ui"] }],
      permissions: { authorize: vi.fn(async () => true) } as unknown as PermissionService,
      audit: { write: vi.fn(async () => undefined) },
      studioUiEnabled: true,
      resolvePrincipal: () => OAuthPrincipalSchema.parse({
        subjectId: "user-1", tenantId: "tenant-1", roles: ["user"], audience: "admin-ui",
      }),
    });
    const requestContext = new RequestContext();
    const next = vi.fn(async () => undefined);
    const raw = new Request("http://localhost:4111/studio/api/workflows/run-counts");

    await (middleware as Exclude<typeof middleware, { path: string }>)({
      req: {
        path: new URL(raw.url).pathname,
        method: raw.method,
        raw,
        header: (name: string) => name.toLowerCase() === "x-mastra-client-type" ? "studio" : undefined,
      },
      get: (key: string) => key === "requestContext" ? requestContext : undefined,
      json: vi.fn(),
    } as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(requestContext.get("applicationId")).toBe("alpha");
    expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe("alpha:tenant-1:user-1");
  });

  it("scopes OpenAI-compatible protocol requests to their application", async () => {
    const authorize = vi.fn(async () => true);
    const middleware = createAuthorizationMiddleware({
      catalog: [entries[0]!, entries[4]!, entries[5]!],
      permissions: { authorize } as unknown as PermissionService,
      audit: { write: vi.fn(async () => undefined) },
      studioUiEnabled: true,
      resolvePrincipal: () => OAuthPrincipalSchema.parse({
        subjectId: "user-1", tenantId: "tenant-1", roles: ["user"], audience: "api",
      }),
    });
    const handler = middleware as Exclude<typeof middleware, { path: string }>;
    const requests = [
      new Request("http://localhost:4111/studio/api/v1/conversations/conversation-1"),
      new Request("http://localhost:4111/studio/api/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: "alpha-main", input: "hello" }),
      }),
    ];

    for (const raw of requests) {
      const requestContext = new RequestContext();
      const next = vi.fn(async () => undefined);
      await handler({
        req: {
          path: new URL(raw.url).pathname,
          method: raw.method,
          raw,
          header: (name: string) => raw.headers.get(name) ?? undefined,
        },
        get: (key: string) => key === "requestContext" ? requestContext : undefined,
        json: vi.fn(),
      } as never, next);

      expect(next).toHaveBeenCalledOnce();
      expect(requestContext.get("applicationId")).toBe("alpha");
      expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe("alpha:tenant-1:user-1");
    }
    expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({
      resourceType: "agent", resourceId: "alpha-main", permission: "alpha.agent.execute",
    }));
  });

  it("classifies the pinned Mastra 1.59 route surface and denies unknown routes", () => {
    const catalog = new Map(entries.map(entry => [`${entry.resourceType}:${entry.resourceId}`, entry]));
    for (const expected of manifest) {
      const actual = classifyRuntimeRoute(expected.path, expected.method, catalog, []);
      expect(actual, `${expected.method} ${expected.path}`).toMatchObject({
        resourceType: expected.type, resourceId: expected.id, action: expected.action,
      });
    }
    expect(classifyRuntimeRoute("/studio/api/new-mastra-surface", "GET", catalog, [])).toMatchObject({
      resourceType: "platform", resourceId: "runtime", action: "read",
    });
    expect(classifyRuntimeRoute("/studio/api/agents/providers", "GET", catalog, [])).toMatchObject({
      resourceType: "platform", resourceId: "runtime", action: "read",
    });
    const ambiguousProtocols = new Map(catalog);
    ambiguousProtocols.set("protocol:beta:responses", {
      applicationId: "beta", resourceType: "protocol", resourceId: "beta:responses",
      permission: "beta.agent.execute", audiences: ["api"],
    });
    expect(classifyRuntimeRoute("/studio/api/v1/responses", "POST", ambiguousProtocols, [])).toBeUndefined();
    for (const [method, path] of [
      ["GET", "/studio/api/background-tasks"],
      ["GET", "/studio/api/background-tasks/task-1"],
      ["GET", "/studio/api/schedules"],
      ["POST", "/studio/api/schedules/schedule-1/run"],
    ] as const) {
      expect(classifyRuntimeRoute(path, method, catalog, []), `${method} ${path}`).toBeUndefined();
    }
    expect(classifyRuntimeRoute("/api/unclassified/danger", "POST", catalog, [])).toBeUndefined();
    expect(classifyRuntimeRoute("/studio/api/agents/not-registered/generate", "POST", catalog, [])).toBeUndefined();
  });

  it("preserves public custom-route metadata for pre-login shells", () => {
    const publicRoute: CatalogEntry = {
      applicationId: "platform", resourceType: "route", resourceId: "platform-shell",
      routePath: "/admin", routeMethod: "GET", permission: "platform.admin-ui.access",
      audiences: ["admin-ui"], public: true,
    };
    expect(classifyRuntimeRoute("/admin", "GET", new Map(), [publicRoute])).toMatchObject({
      resourceId: "platform-shell", public: true,
    });
  });

  it("isolates role grants by tenant and reserves bootstrap bypass for platform-admin", async () => {
    const store = new InMemoryPermissionStore();
    const permissions = new PermissionService(store);
    store.grant("tenant-a", "user", "alpha.agent.execute");
    const check = (tenantId: string, roles: string[]) => permissions.authorize({
      principal: createServicePrincipal({ subjectId: "subject", tenantId, roles }),
      applicationId: "alpha", resourceType: "agent", resourceId: "alpha-main", action: "execute",
      permission: "alpha.agent.execute",
    });
    await expect(check("tenant-a", ["user"])).resolves.toBe(true);
    await expect(check("tenant-b", ["user"])).resolves.toBe(false);
    await store.bindSubjectRole("tenant-b", "subject", "delegated");
    store.grant("tenant-b", "delegated", "alpha.agent.execute");
    await expect(check("tenant-b", ["user"])).resolves.toBe(true);
    await expect(check("tenant-b", ["platform-admin"])).resolves.toBe(true);
  });
});
