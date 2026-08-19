import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import type { AgentApplicationBundle, ApplicationUiManifest, CatalogEntry, OwnedApiRoute } from "../../runtime/application.ts";
import type { AuditLog } from "../auth/audit-log.ts";
import { OAuthPrincipalSchema } from "../auth/oauth-principal.ts";
import type { PermissionService } from "../auth/permission-store.ts";
import type { OAuthPrincipal } from "../auth/oauth-principal.ts";
import { GoogleOidcError, type GoogleOidcService } from "../auth/google-oidc.ts";
import { loadAdminUiHtml } from "./shell.ts";

export function createAdminUiApplication(options: {
  applicationCatalog: readonly CatalogEntry[];
  applications?: readonly { id: string; ui?: ApplicationUiManifest }[];
  permissions: PermissionService;
  audit: AuditLog;
  googleOidc: GoogleOidcService;
}): AgentApplicationBundle {
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
        assertSameOrigin(c.req.raw);
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
      assertSameOrigin(c.req.raw);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const input = z.object({ role: z.string().min(1), permission: z.string().min(1) }).parse(await c.req.json());
      await options.permissions.grantRolePermission(principal.tenantId, input.role, input.permission);
      await options.audit.write({ requestId: String(c.get("requestContext").get("requestId")), tenantId: principal.tenantId,
        subjectId: principal.subjectId, applicationId: "platform", resourceType: "permission", resourceId: input.role,
        action: "grant", decision: "allow", reason: "permission_mutation", metadata: { permission: input.permission } });
      return c.json({ granted: true });
    } })),
    owned("permission-binding", "platform.permissions.manage", registerApiRoute("/admin/api/permissions/bindings", { method: "POST", handler: async c => {
      assertSameOrigin(c.req.raw);
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const input = z.object({ subjectId: z.string().min(1), role: z.string().min(1) }).parse(await c.req.json());
      await options.permissions.bindSubjectRole(principal.tenantId, input.subjectId, input.role);
      await options.audit.write({ requestId: String(c.get("requestContext").get("requestId")), tenantId: principal.tenantId,
        subjectId: principal.subjectId, applicationId: "platform", resourceType: "permission-binding", resourceId: input.subjectId,
        action: "bind", decision: "allow", reason: "permission_mutation", metadata: { role: input.role } });
      return c.json({ bound: true });
    } })),
  ];
  return { id: "platform", agents: {}, workflows: {}, access: { agents: {}, workflows: {} }, routes };
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

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new Error("CSRF origin check failed");
}
