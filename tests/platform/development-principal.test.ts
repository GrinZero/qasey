import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_AUTH_SUBJECT_ID,
  DEVELOPMENT_AUTH_TENANT_ID,
  resolveDevelopmentPrincipal,
} from "../../src/platform/auth/development-principal.ts";
import { createAuthorizationMiddleware, isMastraStudioRequest } from "../../src/platform/auth/authorization-middleware.ts";
import { InMemoryPermissionStore, PermissionService } from "../../src/platform/auth/permission-store.ts";
import type { CatalogEntry } from "../../src/runtime/application.ts";

const token = "dev-auth-token-that-is-at-least-32-characters";

describe("development principal", () => {
  it("maps an exact development Bearer token to a server-owned admin identity", () => {
    const principal = resolveDevelopmentPrincipal({
      nodeEnv: "development",
      configuredToken: token,
      authorization: `Bearer ${token}`,
      audience: "api",
    });

    expect(principal).toEqual({
      subjectId: DEVELOPMENT_AUTH_SUBJECT_ID,
      tenantId: DEVELOPMENT_AUTH_TENANT_ID,
      roles: ["platform-admin"],
      audience: "api",
      service: false,
    });
  });

  it("uses the admin-ui audience only when the server classifies the request that way", () => {
    expect(resolveDevelopmentPrincipal({
      nodeEnv: "development",
      configuredToken: token,
      authorization: `bearer ${token}`,
      audience: "admin-ui",
    })?.audience).toBe("admin-ui");
  });

  it("authorizes a user-only API route and writes trusted development identity context", async () => {
    const route: CatalogEntry = {
      applicationId: "qasey",
      resourceType: "route",
      resourceId: "qasey-task",
      routePath: "/v1/qasey/tasks",
      routeMethod: "POST",
      permission: "qasey.agent.execute",
      audiences: ["admin-ui", "api"],
    };
    const middleware = createAuthorizationMiddleware({
      catalog: [route],
      permissions: new PermissionService(new InMemoryPermissionStore()),
      audit: { write: vi.fn(async () => undefined) },
      resolvePrincipal: (_requestContext, request) => resolveDevelopmentPrincipal({
        nodeEnv: "development",
        configuredToken: token,
        authorization: request.header("authorization"),
        audience: request.path.startsWith("/admin") || isMastraStudioRequest(request) ? "admin-ui" : "api",
      }),
    });
    const raw = new Request("http://localhost:4111/v1/qasey/tasks", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const requestContext = new RequestContext();
    const next = vi.fn(async () => undefined);

    await (middleware as Exclude<typeof middleware, { path: string }>)({
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
    expect(requestContext.get("userId")).toBe(DEVELOPMENT_AUTH_SUBJECT_ID);
    expect(requestContext.get("tenantId")).toBe(DEVELOPMENT_AUTH_TENANT_ID);
    expect(requestContext.get("identity")).toEqual({
      userId: DEVELOPMENT_AUTH_SUBJECT_ID,
      tenantId: DEVELOPMENT_AUTH_TENANT_ID,
      roles: ["platform-admin"],
      service: false,
    });
  });

  it.each([
    { name: "missing configuration", nodeEnv: "development" as const, configuredToken: undefined, authorization: `Bearer ${token}` },
    { name: "wrong token", nodeEnv: "development" as const, configuredToken: token, authorization: "Bearer wrong-token" },
    { name: "malformed header", nodeEnv: "development" as const, configuredToken: token, authorization: `Basic ${token}` },
    { name: "test environment", nodeEnv: "test" as const, configuredToken: token, authorization: `Bearer ${token}` },
    { name: "production environment", nodeEnv: "production" as const, configuredToken: token, authorization: `Bearer ${token}` },
  ])("rejects $name", ({ nodeEnv, configuredToken, authorization }) => {
    expect(resolveDevelopmentPrincipal({
      nodeEnv,
      configuredToken,
      authorization,
      audience: "api",
    })).toBeUndefined();
  });
});
