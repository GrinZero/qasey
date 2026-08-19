import { describe, expect, it } from "vitest";
import manifest from "../fixtures/mastra-route-permissions.json";
import type { CatalogEntry } from "../../src/runtime/application.ts";
import { classifyMastraStudioRoute, classifyRuntimeRoute, isMastraStudioRequest, isPublicRuntimePath, resolveRequestUser } from "../../src/platform/auth/authorization-middleware.ts";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";
import { createServicePrincipal } from "../../src/platform/auth/oauth-principal.ts";

const entries: CatalogEntry[] = [
  { applicationId: "alpha", resourceType: "agent", resourceId: "alpha-main", permission: "alpha.agent.execute", audiences: ["api", "channel"] },
  { applicationId: "alpha", resourceType: "workflow", resourceId: "alpha-job", permission: "alpha.workflow.execute", audiences: ["api"] },
  { applicationId: "alpha", resourceType: "scorer", resourceId: "alpha-quality", permission: "alpha.scorer.read", audiences: ["admin-ui"] },
  { applicationId: "alpha", resourceType: "channel", resourceId: "slack", permission: "alpha.channel.receive", audiences: ["channel"] },
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
