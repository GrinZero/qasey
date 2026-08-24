import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import type { AgentApplicationBundle, ApplicationUiManifest, CatalogEntry, OwnedApiRoute } from "../../runtime/application.ts";
import type { AuditLog } from "../auth/audit-log.ts";
import { OAuthPrincipalSchema } from "../auth/oauth-principal.ts";
import type { PermissionService } from "../auth/permission-store.ts";
import type { OAuthPrincipal } from "../auth/oauth-principal.ts";
import { GoogleOidcError, type GoogleOidcService } from "../auth/google-oidc.ts";
import { loadAdminUiHtml } from "./shell.ts";
import { TriggerProviderError, type TriggerProviderRegistry } from "../triggers/trigger-provider-registry.ts";

export function createAdminUiApplication(options: {
  publicBaseUrl: string;
  applicationCatalog: readonly CatalogEntry[];
  applications?: readonly { id: string; ui?: ApplicationUiManifest }[];
  permissions: PermissionService;
  audit: AuditLog;
  googleOidc: GoogleOidcService;
  triggerProviders?: TriggerProviderRegistry;
}): AgentApplicationBundle {
  const trustedOrigin = new URL(options.publicBaseUrl).origin;
  const routes: OwnedApiRoute[] = [
    owned("shell", "platform.admin-ui.access", registerApiRoute("/admin", {
      method: "GET",
      requiresAuth: false,
      handler: async c => {
        c.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        c.header("referrer-policy", "no-referrer");
        c.header("x-content-type-options", "nosniff");
        c.header("cache-control", "no-cache");
        return c.html(await loadAdminUiHtml());
      },
    }), true),
    owned("google-login", "platform.auth.login", registerApiRoute("/auth/google/login", {
      method: "GET",
      requiresAuth: false,
      handler: async c => {
        try {
          const login = options.googleOidc.createAuthorizationRequest(new URL(c.req.raw.url).searchParams.get("redirect_uri") ?? undefined);
          c.header("set-cookie", login.cookie);
          c.header("cache-control", "no-store");
          return c.json({ url: login.url });
        } catch (error) {
          if (error instanceof GoogleOidcError && error.code === "not_configured") {
            return c.json({ message: "Google 登录尚未配置。" }, 503);
          }
          throw error;
        }
      },
    }), true),
    owned("google-callback", "platform.auth.login", registerApiRoute("/auth/google/callback", {
      method: "GET",
      requiresAuth: false,
      handler: async c => {
        try {
          const result = await options.googleOidc.handleCallback(c.req.raw);
          for (const cookie of result.cookies) c.header("set-cookie", cookie, { append: true });
          c.header("cache-control", "no-store");
          return c.redirect(result.redirectTo, 302);
        } catch (error) {
          c.header("set-cookie", options.googleOidc.clearLoginCookie());
          c.header("cache-control", "no-store");
          const code = error instanceof GoogleOidcError ? error.code : "oauth_failed";
          return c.redirect(`/admin?error=${encodeURIComponent(code)}`, 302);
        }
      },
    }), true),
    owned("logout", "platform.auth.logout", registerApiRoute("/auth/logout", {
      method: "POST",
      requiresAuth: false,
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, trustedOrigin);
        if (csrfFailure) return csrfFailure;
        c.header("set-cookie", options.googleOidc.clearSessionCookie());
        c.header("cache-control", "no-store");
        return c.json({ success: true });
      },
    }), true),
    owned("session", "platform.admin-ui.access", registerApiRoute("/admin/api/session", { method: "GET", handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      return c.json({
        subjectId: principal.subjectId,
        tenantId: principal.tenantId,
        roles: principal.roles,
        ...(principal.email ? { email: principal.email } : {}),
        isAdmin: principal.roles.includes("platform-admin"),
      });
    } })),
    owned("catalog", "platform.admin-ui.access", registerApiRoute("/admin/api/catalog", { method: "GET", handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const visible = (await Promise.all(options.applicationCatalog.map(async entry =>
        await options.permissions.authorize({
          principal, applicationId: entry.applicationId, resourceType: entry.resourceType,
          resourceId: entry.resourceId, action: "read", permission: entry.permission,
        }) ? entry : undefined,
      ))).filter((entry): entry is CatalogEntry => Boolean(entry));
      return c.json(visible);
    } })),
    owned("applications", "platform.admin-ui.access", registerApiRoute("/admin/api/applications", { method: "GET", handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      return c.json(await listVisibleApplicationManifests({ ...options, principal }));
    } })),
    owned("audit", "platform.audit.read", registerApiRoute("/admin/api/audit", { method: "GET", handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      return c.json({ records: await options.audit.list?.(principal.tenantId, 100) ?? [] });
    } })),
    owned("permission-grant", "platform.permissions.manage", registerApiRoute("/admin/api/permissions/grants", { method: "POST", handler: async c => {
      const csrfFailure = rejectCrossOriginRequest(c, trustedOrigin);
      if (csrfFailure) return csrfFailure;
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const input = z.object({ role: z.string().min(1), permission: z.string().min(1) }).parse(await c.req.json());
      await options.permissions.grantRolePermission(principal.tenantId, input.role, input.permission);
      await options.audit.write({ requestId: String(c.get("requestContext").get("requestId")), tenantId: principal.tenantId,
        subjectId: principal.subjectId, applicationId: "platform", resourceType: "permission", resourceId: input.role,
        action: "grant", decision: "allow", reason: "permission_mutation", metadata: { permission: input.permission } });
      return c.json({ granted: true });
    } })),
    owned("permission-binding", "platform.permissions.manage", registerApiRoute("/admin/api/permissions/bindings", { method: "POST", handler: async c => {
      const csrfFailure = rejectCrossOriginRequest(c, trustedOrigin);
      if (csrfFailure) return csrfFailure;
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const input = z.object({ subjectId: z.string().min(1), role: z.string().min(1) }).parse(await c.req.json());
      await options.permissions.bindSubjectRole(principal.tenantId, input.subjectId, input.role);
      await options.audit.write({ requestId: String(c.get("requestContext").get("requestId")), tenantId: principal.tenantId,
        subjectId: principal.subjectId, applicationId: "platform", resourceType: "permission-binding", resourceId: input.subjectId,
        action: "bind", decision: "allow", reason: "permission_mutation", metadata: { role: input.role } });
      return c.json({ bound: true });
    } })),
    ...(options.triggerProviders ? triggerRoutes({
      triggerProviders: options.triggerProviders,
      audit: options.audit,
      trustedOrigin,
    }) : []),
  ];
  return { id: "platform", agents: {}, workflows: {}, access: { agents: {}, workflows: {} }, routes };
}

function triggerRoutes(options: {
  triggerProviders: TriggerProviderRegistry;
  audit: AuditLog;
  trustedOrigin: string;
}): OwnedApiRoute[] {
  const configuration = z.record(z.string(), z.string());
  const revision = z.number().int().positive();
  return [
    owned("trigger-providers", "platform.triggers.read", registerApiRoute("/admin/api/triggers/providers", {
      method: "GET",
      handler: async c => c.json({ providers: options.triggerProviders.listProviders() }),
    })),
    owned("trigger-targets", "platform.triggers.read", registerApiRoute("/admin/api/triggers/providers/:providerId/targets", {
      method: "GET",
      handler: async c => {
        const principal = adminPrincipal(c);
        return c.json({ targets: await options.triggerProviders.targets(c.req.param("providerId"), principal.tenantId) });
      },
    })),
    owned("trigger-connections", "platform.triggers.read", registerApiRoute("/admin/api/triggers/connections", {
      method: "GET",
      handler: async c => {
        const principal = adminPrincipal(c);
        return c.json({ connections: await options.triggerProviders.listConnections(principal.tenantId) });
      },
    })),
    owned("trigger-create", "platform.triggers.manage", registerApiRoute("/admin/api/triggers/connections", {
      method: "POST",
      handler: async c => triggerMutation(c, options, "create", async principal => {
        const input = z.object({
          providerId: z.string().min(1),
          displayName: z.string().trim().min(1).max(80),
          targetId: z.string().min(1),
          configuration,
        }).parse(await c.req.json());
        const connection = await options.triggerProviders.create(input.providerId, {
          tenantId: principal.tenantId, actorId: principal.subjectId,
          displayName: input.displayName, targetId: input.targetId, configuration: input.configuration,
        });
        return { connection, status: 201 as const };
      }),
    })),
    owned("trigger-configuration", "platform.triggers.manage", registerApiRoute("/admin/api/triggers/connections/:providerId/:id/configuration", {
      method: "PATCH",
      handler: async c => triggerMutation(c, options, "configuration_update", async principal => {
        const input = z.object({ revision, configuration }).parse(await c.req.json());
        const connection = await options.triggerProviders.updateConfiguration(c.req.param("providerId"), {
          tenantId: principal.tenantId, actorId: principal.subjectId, id: c.req.param("id"),
          revision: input.revision, configuration: input.configuration,
        });
        return { connection };
      }),
    })),
    owned("trigger-rebind", "platform.triggers.manage", registerApiRoute("/admin/api/triggers/connections/:providerId/:id/rebind", {
      method: "POST",
      handler: async c => triggerMutation(c, options, "rebind", async principal => {
        const input = z.object({ revision, targetId: z.string().min(1) }).parse(await c.req.json());
        const connection = await options.triggerProviders.rebind(c.req.param("providerId"), {
          tenantId: principal.tenantId, actorId: principal.subjectId, id: c.req.param("id"),
          revision: input.revision, targetId: input.targetId,
        });
        return { connection };
      }),
    })),
    owned("trigger-status", "platform.triggers.manage", registerApiRoute("/admin/api/triggers/connections/:providerId/:id/status", {
      method: "POST",
      handler: async c => triggerMutation(c, options, "status_change", async principal => {
        const input = z.object({ revision, enabled: z.boolean() }).parse(await c.req.json());
        const connection = await options.triggerProviders.setEnabled(c.req.param("providerId"), {
          tenantId: principal.tenantId, actorId: principal.subjectId, id: c.req.param("id"), ...input,
        });
        return { connection };
      }),
    })),
    owned("trigger-delete", "platform.triggers.manage", registerApiRoute("/admin/api/triggers/connections/:providerId/:id", {
      method: "DELETE",
      handler: async c => triggerMutation(c, options, "delete", async principal => {
        const input = z.object({ revision }).parse(await c.req.json());
        const id = c.req.param("id");
        await options.triggerProviders.delete(c.req.param("providerId"), {
          tenantId: principal.tenantId, actorId: principal.subjectId, id, ...input,
        });
        return { deleted: true };
      }),
    })),
  ];
}

function adminPrincipal(c: { get(key: string): unknown }): OAuthPrincipal {
  const context = c.get("requestContext") as { get(key: string): unknown };
  return OAuthPrincipalSchema.parse(context.get("platform-principal"));
}

async function triggerMutation(
  c: any,
  options: { audit: AuditLog; trustedOrigin: string },
  action: string,
  execute: (principal: OAuthPrincipal) => Promise<Record<string, unknown> & {
    connection?: { id: string; providerId: string; target?: { id: string } };
    status?: 201;
  }>,
): Promise<Response> {
  try {
    const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
    if (csrfFailure) return csrfFailure;
    const principal = adminPrincipal(c);
    const result = await execute(principal);
    const connection = result.connection;
    await options.audit.write({
      requestId: String(c.get("requestContext").get("requestId")),
      tenantId: principal.tenantId,
      subjectId: principal.subjectId,
      applicationId: "platform",
      resourceType: "trigger-connection",
      resourceId: connection?.id ?? c.req.param("id") ?? "new",
      action,
      decision: "allow",
      reason: "trigger_mutation",
      metadata: {
        providerId: connection?.providerId ?? c.req.param("providerId") ?? "unknown",
        ...(connection?.target?.id ? { targetId: connection.target.id } : {}),
      },
    });
    const { status, ...body } = result;
    return c.json(body, status ?? 200);
  } catch (error) {
    if (error instanceof TriggerProviderError) {
      const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    if (error instanceof z.ZodError) return c.json({ error: "invalid_request", message: "提交的数据不完整或格式不正确。" }, 400);
    throw error;
  }
}

export async function listVisibleApplicationManifests(options: {
  applicationCatalog: readonly CatalogEntry[];
  applications?: readonly { id: string; ui?: ApplicationUiManifest }[];
  permissions: PermissionService;
  principal: OAuthPrincipal;
}): Promise<Array<{ id: string } & ApplicationUiManifest>> {
  const applications = await Promise.all((options.applications ?? []).map(async application => {
    if (!application.ui) return undefined;
    const resources = options.applicationCatalog.filter(entry => entry.applicationId === application.id);
    const visible = await Promise.all(resources.map(entry => options.permissions.authorize({
      principal: options.principal,
      applicationId: entry.applicationId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      action: "read",
      permission: entry.permission,
    })));
    return visible.some(Boolean) ? { id: application.id, ...application.ui } : undefined;
  }));
  return applications.filter((application): application is { id: string } & ApplicationUiManifest => Boolean(application));
}

function owned(id: string, permission: string, route: OwnedApiRoute["route"], publicRoute = false): OwnedApiRoute {
  return { id, route, access: { permission, audiences: ["admin-ui"] }, ...(publicRoute ? { public: true } : {}) };
}

class CsrfOriginError extends Error {
  constructor() {
    super("CSRF origin check failed");
    this.name = "CsrfOriginError";
  }
}

function rejectCrossOriginRequest(c: any, trustedOrigin: string): Response | undefined {
  try {
    assertSameOrigin(c.req.raw, trustedOrigin);
    return undefined;
  } catch (error) {
    if (!(error instanceof CsrfOriginError)) throw error;
    return c.json({ error: "forbidden", message: "请求来源验证失败。" }, 403);
  }
}

export function assertSameOrigin(request: Request, trustedOrigin: string): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new CsrfOriginError();
  try {
    if (new URL(origin).origin !== new URL(trustedOrigin).origin) throw new CsrfOriginError();
  } catch (error) {
    if (error instanceof CsrfOriginError) throw error;
    throw new CsrfOriginError();
  }
}
