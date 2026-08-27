import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import type { AgentApplicationBundle, ApplicationUiManifest, CatalogEntry, OwnedApiRoute } from "../../runtime/application.ts";
import type { AuditLog } from "../auth/audit-log.ts";
import { OAuthPrincipalSchema } from "../auth/oauth-principal.ts";
import type { PermissionService } from "../auth/permission-store.ts";
import type { OAuthPrincipal } from "../auth/oauth-principal.ts";
import { GoogleOidcError, type GoogleOidcService, type PlatformBrowserUser } from "../auth/google-oidc.ts";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordAuthError,
  type PasswordAuthService,
} from "../auth/password-auth.ts";
import { loadAdminUiHtml } from "./shell.ts";
import { TriggerProviderError, type TriggerProviderRegistry } from "../triggers/trigger-provider-registry.ts";
import type { ApiTokenStore } from "../auth/api-token-store.ts";
import {
  ExternalConnectionStoreError,
  type ExternalConnectionProvider,
  type ExternalConnectionStore,
} from "../connections/connection-store.ts";
import {
  FailureInboxError,
  FailureRedriveService,
  type FailureInboxStatus,
  type FailureInboxStore,
} from "../recovery/failure-inbox.ts";
import type { RunRepository } from "../../../packages/domain/src/index.ts";
import type { E2ERun, OwnerScope } from "../../../packages/contracts/src/index.ts";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import {
  OrganizationMembershipNotFoundError,
  OrganizationStoreConflictError,
  OrganizationStoreNotFoundError,
  type OrganizationStore,
} from "../auth/organization-store.ts";

export function createAdminUiApplication(options: {
  publicBaseUrl: string;
  applicationCatalog: readonly CatalogEntry[];
  applications?: readonly { id: string; ui?: ApplicationUiManifest }[];
  permissions: PermissionService;
  audit: AuditLog;
  googleOidc: GoogleOidcService;
  passwordAuth?: PasswordAuthService;
  apiTokens?: ApiTokenStore;
  organizations?: OrganizationStore;
  triggerProviders?: TriggerProviderRegistry;
  externalConnections?: ExternalConnectionStore;
  failureRecovery?: {
    failures: FailureInboxStore;
    runs: RunRepository;
    createRedrive(
      owner: OwnerScope,
      sourceRunId: string,
      runtime: { mastra: Mastra; requestContext: RequestContext; actorId: string },
    ): Promise<E2ERun>;
  };
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
    owned("auth-config", "platform.auth.login", registerApiRoute("/auth/config", {
      method: "GET",
      requiresAuth: false,
      handler: async c => {
        c.header("cache-control", "no-store");
        return c.json({
          google: options.googleOidc.configured,
          password: options.passwordAuth?.configured ?? false,
          registration: options.passwordAuth?.registrationConfigured ?? false,
        });
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
          c.header("set-cookie", options.googleOidc.clearLoginCookie(), { append: true });
          c.header("set-cookie", options.googleOidc.clearOrganizationSelectionCookie(), { append: true });
          c.header("cache-control", "no-store");
          const code = error instanceof GoogleOidcError ? error.code : "oauth_failed";
          return c.redirect(`/admin?error=${encodeURIComponent(code)}`, 302);
        }
      },
    }), true),
    owned("organization-selection", "platform.auth.login", registerApiRoute("/auth/organization-selection", {
      method: "GET",
      requiresAuth: false,
      handler: async c => {
        c.header("cache-control", "no-store");
        return c.json({ selection: await options.googleOidc.getOrganizationSelection(c.req.raw) });
      },
    }), true),
    owned("organization-selection-complete", "platform.auth.login", registerApiRoute("/auth/organization-selection", {
      method: "POST",
      requiresAuth: false,
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, trustedOrigin);
        if (csrfFailure) return csrfFailure;
        c.header("cache-control", "no-store");
        try {
          const input = z.object({
            organizationId: z.string().trim().min(1).max(255),
          }).strict().parse(await c.req.json());
          const result = await options.googleOidc.completeOrganizationSelection(c.req.raw, input.organizationId);
          for (const cookie of result.cookies) c.header("set-cookie", cookie, { append: true });
          return c.json({ redirectTo: result.redirectTo });
        } catch (error) {
          if (error instanceof z.ZodError) return invalidAdminRequest(c);
          if (error instanceof GoogleOidcError) {
            if (error.code === "organization_selection_required") {
              c.header("set-cookie", options.googleOidc.clearOrganizationSelectionCookie(), { append: true });
            }
            return c.json({
              error: error.code,
              message: error.code === "membership_required"
                ? "该组织访问权限已失效，请重新选择或登录。"
                : "组织选择已过期，请重新登录。",
            }, 409);
          }
          throw error;
        }
      },
    }), true),
    ...(options.passwordAuth ? passwordAuthRoutes({
      passwordAuth: options.passwordAuth,
      googleOidc: options.googleOidc,
      trustedOrigin,
    }) : []),
    owned("logout", "platform.auth.logout", registerApiRoute("/auth/logout", {
      method: "POST",
      requiresAuth: false,
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, trustedOrigin);
        if (csrfFailure) return csrfFailure;
        await options.googleOidc.revokeCurrentSession(c.req.raw);
        c.header("set-cookie", options.googleOidc.clearSessionCookie());
        c.header("cache-control", "no-store");
        return c.json({ success: true });
      },
    }), true),
    owned("session", "platform.admin-ui.access", registerApiRoute("/admin/api/session", { method: "GET", handler: async c => {
      const principal = OAuthPrincipalSchema.parse(c.get("requestContext").get("platform-principal"));
      const browserUser = c.get("requestContext").get("user") as PlatformBrowserUser | undefined;
      return c.json({
        subjectId: principal.subjectId,
        tenantId: principal.tenantId,
        roles: principal.roles,
        ...(principal.email ? { email: principal.email } : {}),
        ...(browserUser?.name ? { displayName: browserUser.name } : {}),
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
    ...(options.apiTokens ? apiTokenRoutes({
      apiTokens: options.apiTokens,
      applicationCatalog: options.applicationCatalog,
      audit: options.audit,
      trustedOrigin,
    }) : []),
    ...(options.organizations ? organizationRoutes({
      organizations: options.organizations,
      ...(options.apiTokens ? { apiTokens: options.apiTokens } : {}),
      permissions: options.permissions,
      audit: options.audit,
      trustedOrigin,
    }) : []),
    ...(options.externalConnections ? externalConnectionRoutes({
      connections: options.externalConnections,
      audit: options.audit,
      trustedOrigin,
    }) : []),
    ...(options.failureRecovery ? failureRecoveryRoutes({
      ...options.failureRecovery,
      audit: options.audit,
      trustedOrigin,
    }) : []),
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
    owned("shell-fallback", "platform.admin-ui.access", registerApiRoute("/admin/*", {
      method: "GET",
      requiresAuth: false,
      handler: async c => {
        if (c.req.path.startsWith("/admin/api/")) return c.json({ error: "not_found" }, 404);
        c.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        c.header("referrer-policy", "no-referrer");
        c.header("x-content-type-options", "nosniff");
        c.header("cache-control", "no-cache");
        return c.html(await loadAdminUiHtml());
      },
    }), true),
  ];
  return { id: "platform", agents: {}, workflows: {}, access: { agents: {}, workflows: {} }, routes };
}

const PasswordLoginInputSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  redirectUri: z.string().max(2_048).optional(),
}).strict();

const PasswordRegistrationInputSchema = PasswordLoginInputSchema.extend({
  displayName: z.string().trim().min(1).max(100).optional(),
}).strict();

function passwordAuthRoutes(options: {
  passwordAuth: PasswordAuthService;
  googleOidc: GoogleOidcService;
  trustedOrigin: string;
}): OwnedApiRoute[] {
  return [
    owned("password-register", "platform.auth.login", registerApiRoute("/auth/password/register", {
      method: "POST",
      requiresAuth: false,
      handler: async c => {
        c.header("cache-control", "no-store");
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        let input: z.infer<typeof PasswordRegistrationInputSchema>;
        try {
          input = PasswordRegistrationInputSchema.parse(await c.req.json());
        } catch {
          return invalidPasswordAuthRequest(c);
        }
        try {
          const result = await options.passwordAuth.register({
            request: c.req.raw,
            email: input.email,
            password: input.password,
            ...(input.displayName ? { displayName: input.displayName } : {}),
            ...(input.redirectUri ? { redirectTo: input.redirectUri } : {}),
          });
          c.header("set-cookie", result.cookie, { append: true });
          c.header("set-cookie", options.googleOidc.clearLoginCookie(), { append: true });
          c.header("set-cookie", options.googleOidc.clearOrganizationSelectionCookie(), { append: true });
          return c.json({ redirectTo: result.redirectTo }, 201);
        } catch (error) {
          return passwordAuthErrorResponse(c, error);
        }
      },
    }), true),
    owned("password-login", "platform.auth.login", registerApiRoute("/auth/password/login", {
      method: "POST",
      requiresAuth: false,
      handler: async c => {
        c.header("cache-control", "no-store");
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        let input: z.infer<typeof PasswordLoginInputSchema>;
        try {
          input = PasswordLoginInputSchema.parse(await c.req.json());
        } catch {
          return invalidPasswordAuthRequest(c);
        }
        try {
          const result = await options.passwordAuth.login({
            request: c.req.raw,
            email: input.email,
            password: input.password,
            ...(input.redirectUri ? { redirectTo: input.redirectUri } : {}),
          });
          c.header("set-cookie", result.cookie, { append: true });
          c.header("set-cookie", options.googleOidc.clearLoginCookie(), { append: true });
          c.header("set-cookie", options.googleOidc.clearOrganizationSelectionCookie(), { append: true });
          return c.json({ redirectTo: result.redirectTo });
        } catch (error) {
          return passwordAuthErrorResponse(c, error);
        }
      },
    }), true),
  ];
}

function invalidPasswordAuthRequest(c: any): Response {
  return c.json({ error: "invalid_input", message: `请输入有效邮箱和 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位密码。` }, 400);
}

function passwordAuthErrorResponse(c: any, error: unknown): Response {
  if (!(error instanceof PasswordAuthError)) throw error;
  if (error.code === "rate_limited") {
    c.header("retry-after", "900");
    return c.json({ error: error.code, message: "尝试次数过多，请 15 分钟后再试。" }, 429);
  }
  if (error.code === "invalid_credentials") {
    return c.json({ error: error.code, message: "邮箱或密码不正确。" }, 401);
  }
  if (error.code === "account_exists") {
    return c.json({ error: error.code, message: "该邮箱已注册，请直接登录。" }, 409);
  }
  if (error.code === "membership_required") {
    return c.json({ error: error.code, message: "此账号当前无权访问该组织。" }, 403);
  }
  if (error.code === "registration_disabled") {
    return c.json({ error: error.code, message: "管理员未开放自助注册。" }, 403);
  }
  if (error.code === "not_configured") {
    return c.json({ error: error.code, message: "密码登录尚未配置。" }, 503);
  }
  return invalidPasswordAuthRequest(c);
}

function apiTokenRoutes(options: {
  apiTokens: ApiTokenStore;
  applicationCatalog: readonly CatalogEntry[];
  audit: AuditLog;
  trustedOrigin: string;
}): OwnedApiRoute[] {
  const availableScopes = availableApiTokenScopes(options.applicationCatalog);
  const scopeSet = new Set(availableScopes);
  return [
    owned("api-token-list", "platform.api-tokens.manage", registerApiRoute("/admin/api/tokens", {
      method: "GET",
      handler: async c => {
        const principal = adminPrincipal(c);
        return c.json({ tokens: await options.apiTokens.list(principal.tenantId), availableScopes });
      },
    })),
    owned("api-token-create", "platform.api-tokens.manage", registerApiRoute("/admin/api/tokens", {
      method: "POST",
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        const principal = adminPrincipal(c);
        const input = z.object({
          name: z.string().trim().min(1).max(80),
          scopes: z.array(z.string().min(1)).min(1).max(50),
          expiresAt: z.iso.datetime().optional(),
        }).parse(await c.req.json());
        const scopes = [...new Set(input.scopes)];
        if (scopes.some(scope => !scopeSet.has(scope))) {
          return c.json({ error: "invalid_scope", message: "Token 包含不可用于 API 的权限。" }, 400);
        }
        if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
          return c.json({ error: "invalid_expiration", message: "过期时间必须晚于当前时间。" }, 400);
        }
        const created = await options.apiTokens.create({
          tenantId: principal.tenantId,
          name: input.name,
          scopes,
          createdBy: principal.subjectId,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        });
        await options.audit.write({
          requestId: String(c.get("requestContext").get("requestId")), tenantId: principal.tenantId,
          subjectId: principal.subjectId, applicationId: "platform", resourceType: "api-token",
          resourceId: created.record.id, action: "create", decision: "allow", reason: "api_token_created",
          metadata: { name: created.record.name, scopes: created.record.scopes, expiresAt: created.record.expiresAt },
        });
        return c.json(created, 201);
      },
    })),
    owned("api-token-revoke", "platform.api-tokens.manage", registerApiRoute("/admin/api/tokens/:tokenId", {
      method: "DELETE",
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        const principal = adminPrincipal(c);
        const tokenId = z.uuid().parse(c.req.param("tokenId"));
        const revoked = await options.apiTokens.revoke(principal.tenantId, tokenId);
        if (!revoked) return c.json({ error: "not_found" }, 404);
        await options.audit.write({
          requestId: String(c.get("requestContext").get("requestId")), tenantId: principal.tenantId,
          subjectId: principal.subjectId, applicationId: "platform", resourceType: "api-token",
          resourceId: tokenId, action: "revoke", decision: "allow", reason: "api_token_revoked",
        });
        return c.json({ revoked: true });
      },
    })),
  ];
}

function organizationRoutes(options: {
  organizations: OrganizationStore;
  apiTokens?: ApiTokenStore;
  permissions: PermissionService;
  audit: AuditLog;
  trustedOrigin: string;
}): OwnedApiRoute[] {
  return [
    owned("organization-members", "platform.members.read", registerApiRoute("/admin/api/organization/members", {
      method: "GET",
      handler: async c => {
        const principal = adminPrincipal(c);
        try {
          const limit = boundedAdminLimit(c.req.query("limit"));
          return c.json({ members: await options.organizations.listMemberships(principal.tenantId, limit) });
        } catch (error) {
          if (error instanceof z.ZodError) return invalidAdminRequest(c);
          throw error;
        }
      },
    })),
    owned("organization-member-status", "platform.members.manage", registerApiRoute("/admin/api/organization/members/:userId", {
      method: "PATCH",
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        const principal = adminPrincipal(c);
        try {
          const userId = z.uuid().parse(c.req.param("userId"));
          const input = z.object({ status: z.enum(["active", "suspended", "removed"]) }).parse(await c.req.json());
          if (userId === principal.subjectId && input.status !== "active") {
            return c.json({ error: "cannot_deprovision_self", message: "不能停用当前管理员会话。" }, 400);
          }
          const membership = await options.organizations.updateMembershipStatus(
            { applicationId: "platform", tenantId: principal.tenantId },
            {
              organizationId: principal.tenantId,
              userId,
              status: input.status,
            },
          );
          let revokedTokens = 0;
          let revokedRoles = 0;
          if (input.status !== "active") {
            [revokedTokens, revokedRoles] = await Promise.all([
              options.apiTokens?.revokeByCreator(principal.tenantId, userId) ?? Promise.resolve(0),
              options.permissions.revokeSubjectRoles(principal.tenantId, userId),
            ]);
          }
          await options.audit.write({
            requestId: requestId(c),
            tenantId: principal.tenantId,
            subjectId: principal.subjectId,
            applicationId: "platform",
            resourceType: "organization-membership",
            resourceId: userId,
            action: input.status === "active" ? "activate" : "deprovision",
            decision: "allow",
            reason: "membership_status_changed",
            metadata: { status: membership.status, revokedTokens, revokedRoles },
          });
          return c.json({ membership, revokedTokens, revokedRoles });
        } catch (error) {
          return organizationMutationError(c, error);
        }
      },
    })),
    owned("organization-invitations", "platform.members.read", registerApiRoute("/admin/api/organization/invitations", {
      method: "GET",
      handler: async c => {
        const principal = adminPrincipal(c);
        try {
          const limit = boundedAdminLimit(c.req.query("limit"));
          return c.json({ invitations: await options.organizations.listInvitations(principal.tenantId, limit) });
        } catch (error) {
          if (error instanceof z.ZodError) return invalidAdminRequest(c);
          throw error;
        }
      },
    })),
    owned("organization-invitation-create", "platform.members.manage", registerApiRoute("/admin/api/organization/invitations", {
      method: "POST",
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        const principal = adminPrincipal(c);
        try {
          const input = z.object({
            email: z.email().max(320),
            expiresAt: z.iso.datetime().optional(),
          }).parse(await c.req.json());
          const now = Date.now();
          const expiresAt = input.expiresAt ?? new Date(now + 7 * 24 * 60 * 60_000).toISOString();
          const expiry = Date.parse(expiresAt);
          if (expiry <= now || expiry > now + 30 * 24 * 60 * 60_000) {
            return c.json({ error: "invalid_expiration", message: "邀请有效期必须在未来 30 天内。" }, 400);
          }
          const invitation = await options.organizations.createInvitation({
            organizationId: principal.tenantId,
            email: input.email,
            expiresAt,
            invitedBy: principal.subjectId,
          });
          await options.audit.write({
            requestId: requestId(c),
            tenantId: principal.tenantId,
            subjectId: principal.subjectId,
            applicationId: "platform",
            resourceType: "organization-invitation",
            resourceId: invitation.id,
            action: "create",
            decision: "allow",
            reason: "organization_invitation_created",
            metadata: { expiresAt: invitation.expiresAt },
          });
          return c.json({ invitation }, 201);
        } catch (error) {
          return organizationMutationError(c, error);
        }
      },
    })),
    owned("organization-invitation-revoke", "platform.members.manage", registerApiRoute("/admin/api/organization/invitations/:invitationId", {
      method: "DELETE",
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        const principal = adminPrincipal(c);
        try {
          const invitationId = z.uuid().parse(c.req.param("invitationId"));
          const revoked = await options.organizations.revokeInvitation({
            organizationId: principal.tenantId,
            invitationId,
            revokedBy: principal.subjectId,
          });
          if (!revoked) return c.json({ error: "not_found" }, 404);
          await options.audit.write({
            requestId: requestId(c),
            tenantId: principal.tenantId,
            subjectId: principal.subjectId,
            applicationId: "platform",
            resourceType: "organization-invitation",
            resourceId: invitationId,
            action: "revoke",
            decision: "allow",
            reason: "organization_invitation_revoked",
          });
          return c.json({ revoked: true });
        } catch (error) {
          return organizationMutationError(c, error);
        }
      },
    })),
  ];
}

function boundedAdminLimit(value: string | undefined): number {
  return z.coerce.number().int().min(1).max(200).default(100).parse(value);
}

function organizationMutationError(c: any, error: unknown): Response {
  if (error instanceof z.ZodError || error instanceof RangeError || error instanceof TypeError) {
    return invalidAdminRequest(c);
  }
  if (error instanceof OrganizationStoreNotFoundError) return c.json({ error: "not_found" }, 404);
  if (error instanceof OrganizationMembershipNotFoundError) return c.json({ error: error.code }, 404);
  if (error instanceof OrganizationStoreConflictError) {
    return c.json({ error: error.code, message: "记录已存在，请刷新后重试。" }, 409);
  }
  throw error;
}

const ExternalConnectionProviderSchema = z.enum(["slack", "jira", "github", "mcp"]);
const ExternalConnectionStatusSchema = z.enum(["active", "disabled"]);
const ExternalConnectionRevisionSchema = z.number().int().positive();
const ExternalConnectionConfigurationSchema = z.record(z.string(), z.unknown());
const ExternalConnectionCredentialsSchema = z.record(
  z.string().trim().min(1).max(80),
  z.string().trim().min(1).max(65_536),
).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 50, {
  message: "credentials must contain between 1 and 50 entries",
});

function externalConnectionRoutes(options: {
  connections: ExternalConnectionStore;
  audit: AuditLog;
  trustedOrigin: string;
}): OwnedApiRoute[] {
  return [
    owned("external-connection-list", "platform.connections.read", registerApiRoute("/admin/api/connections", {
      method: "GET",
      handler: async c => {
        const principal = adminPrincipal(c);
        try {
          const providerValue = c.req.query("provider");
          const provider = providerValue
            ? ExternalConnectionProviderSchema.parse(providerValue)
            : undefined;
          return c.json({ connections: await options.connections.list(principal.tenantId, provider) });
        } catch (error) {
          if (error instanceof z.ZodError) return invalidAdminRequest(c);
          throw error;
        }
      },
    })),
    owned("external-connection-create", "platform.connections.manage", registerApiRoute("/admin/api/connections", {
      method: "POST",
      handler: async c => externalConnectionMutation(c, options, "create", async principal => {
        const input = z.object({
          provider: ExternalConnectionProviderSchema,
          name: z.string().trim().min(1).max(80),
          configuration: ExternalConnectionConfigurationSchema.optional(),
          credentials: ExternalConnectionCredentialsSchema,
        }).parse(await c.req.json());
        const connection = await options.connections.create({
          tenantId: principal.tenantId,
          provider: input.provider,
          name: input.name,
          ...(input.configuration ? { configuration: input.configuration } : {}),
          credentials: input.credentials,
          actorId: principal.subjectId,
        });
        return { connection, status: 201 as const };
      }),
    })),
    owned("external-connection-update", "platform.connections.manage", registerApiRoute("/admin/api/connections/:connectionId", {
      method: "PATCH",
      handler: async c => externalConnectionMutation(c, options, "update", async principal => {
        const input = z.object({
          revision: ExternalConnectionRevisionSchema,
          configuration: ExternalConnectionConfigurationSchema.optional(),
          credentials: ExternalConnectionCredentialsSchema.optional(),
          status: ExternalConnectionStatusSchema.optional(),
        }).refine(value => value.configuration !== undefined || value.credentials !== undefined || value.status !== undefined, {
          message: "at least one mutable field is required",
        }).parse(await c.req.json());
        const connection = await options.connections.update({
          tenantId: principal.tenantId,
          id: c.req.param("connectionId"),
          expectedRevision: input.revision,
          ...(input.configuration !== undefined ? { configuration: input.configuration } : {}),
          ...(input.credentials !== undefined ? { credentials: input.credentials } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          actorId: principal.subjectId,
        });
        return { connection };
      }),
    })),
    owned("external-connection-rotate", "platform.connections.manage", registerApiRoute("/admin/api/connections/:connectionId/rotate", {
      method: "POST",
      handler: async c => externalConnectionMutation(c, options, "rotate", async principal => {
        const input = z.object({ revision: ExternalConnectionRevisionSchema }).parse(await c.req.json());
        const connection = await options.connections.rotate(
          principal.tenantId,
          c.req.param("connectionId"),
          input.revision,
          principal.subjectId,
        );
        return { connection };
      }),
    })),
    owned("external-connection-revoke", "platform.connections.manage", registerApiRoute("/admin/api/connections/:connectionId", {
      method: "DELETE",
      handler: async c => externalConnectionMutation(c, options, "revoke", async principal => {
        const input = z.object({ revision: ExternalConnectionRevisionSchema }).parse(await c.req.json());
        const connection = await options.connections.revoke(
          principal.tenantId,
          c.req.param("connectionId"),
          input.revision,
          principal.subjectId,
        );
        return { connection };
      }),
    })),
  ];
}

async function externalConnectionMutation(
  c: any,
  options: { connections: ExternalConnectionStore; audit: AuditLog; trustedOrigin: string },
  action: string,
  execute: (principal: OAuthPrincipal) => Promise<{
    connection: { id: string; provider: ExternalConnectionProvider; status: string; revision: number };
    status?: 201;
  }>,
): Promise<Response> {
  try {
    const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
    if (csrfFailure) return csrfFailure;
    const principal = adminPrincipal(c);
    const result = await execute(principal);
    await options.audit.write({
      requestId: requestId(c),
      tenantId: principal.tenantId,
      subjectId: principal.subjectId,
      applicationId: "platform",
      resourceType: "external-connection",
      resourceId: result.connection.id,
      action,
      decision: "allow",
      reason: "external_connection_mutation",
      metadata: {
        provider: result.connection.provider,
        status: result.connection.status,
        revision: result.connection.revision,
      },
    });
    return c.json({ connection: result.connection }, result.status ?? 200);
  } catch (error) {
    if (error instanceof ExternalConnectionStoreError) {
      const status = error.code === "not_found" ? 404
        : error.code === "duplicate" || error.code === "revision_conflict" ? 409
          : error.code === "key_unavailable" ? 503 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    if (error instanceof z.ZodError) {
      return invalidAdminRequest(c);
    }
    throw error;
  }
}

const FailureInboxStatusSchema = z.enum(["pending", "redriving", "redriven", "exhausted", "closed"]);

function failureRecoveryRoutes(options: {
  failures: FailureInboxStore;
  runs: RunRepository;
  createRedrive(
    owner: OwnerScope,
    sourceRunId: string,
    runtime: { mastra: Mastra; requestContext: RequestContext; actorId: string },
  ): Promise<E2ERun>;
  audit: AuditLog;
  trustedOrigin: string;
}): OwnedApiRoute[] {
  return [
    owned("failure-inbox-list", "platform.failures.read", registerApiRoute("/admin/api/failures", {
      method: "GET",
      handler: async c => {
        const principal = adminPrincipal(c);
        try {
          const rawStatus = c.req.query("status");
          const status: FailureInboxStatus | undefined = rawStatus
            ? FailureInboxStatusSchema.parse(rawStatus)
            : undefined;
          const limit = boundedAdminLimit(c.req.query("limit"));
          return c.json({ failures: await options.failures.list(failureOwner(principal), status, limit) });
        } catch (error) {
          if (error instanceof z.ZodError) return invalidAdminRequest(c);
          throw error;
        }
      },
    })),
    owned("failure-inbox-redrive", "platform.failures.manage", registerApiRoute("/admin/api/failures/:failureId/redrive", {
      method: "POST",
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        const principal = adminPrincipal(c);
        try {
          const input = z.object({ revision: z.number().int().positive() }).parse(await c.req.json());
          const service = new FailureRedriveService(
            options.failures,
            options.runs,
            (owner, sourceRunId) => options.createRedrive(owner, sourceRunId, {
              mastra: c.get("mastra"),
              requestContext: c.get("requestContext"),
              actorId: principal.subjectId,
            }),
            options.audit,
          );
          const failure = await service.redrive({
            owner: failureOwner(principal),
            failureId: c.req.param("failureId"),
            expectedRevision: input.revision,
            actorId: principal.subjectId,
            requestId: requestId(c),
          });
          return c.json({ failure }, 202);
        } catch (error) {
          return failureRecoveryError(c, error, true);
        }
      },
    })),
    owned("failure-inbox-close", "platform.failures.manage", registerApiRoute("/admin/api/failures/:failureId/close", {
      method: "POST",
      handler: async c => {
        const csrfFailure = rejectCrossOriginRequest(c, options.trustedOrigin);
        if (csrfFailure) return csrfFailure;
        const principal = adminPrincipal(c);
        try {
          const input = z.object({ revision: z.number().int().positive() }).parse(await c.req.json());
          const failure = await options.failures.closeItem(
            failureOwner(principal),
            c.req.param("failureId"),
            input.revision,
            principal.subjectId,
          );
          await options.audit.write({
            requestId: requestId(c),
            tenantId: principal.tenantId,
            subjectId: principal.subjectId,
            applicationId: "qasey",
            resourceType: "workflow-failure",
            resourceId: failure.id,
            action: "close",
            decision: "allow",
            reason: "operator_close",
            metadata: { sourceRunId: failure.runId, reasonCode: failure.reasonCode },
          });
          return c.json({ failure });
        } catch (error) {
          return failureRecoveryError(c, error, false);
        }
      },
    })),
  ];
}

function failureOwner(principal: OAuthPrincipal): OwnerScope {
  return { applicationId: "qasey", tenantId: principal.tenantId };
}

function failureRecoveryError(c: any, error: unknown, redrive: boolean): Response {
  if (error instanceof FailureInboxError) {
    const status = error.code === "not_found" ? 404
      : error.code === "revision_conflict" ? 409
        : error.code === "attempts_exhausted" ? 429 : 409;
    return c.json({ error: error.code, message: error.message }, status);
  }
  if (error instanceof z.ZodError) {
    return invalidAdminRequest(c);
  }
  if (redrive) return c.json({ error: "redrive_failed", message: "重驱任务未能启动，请查看失败队列后重试。" }, 503);
  throw error;
}

function requestId(c: { get(key: string): unknown }): string {
  const context = c.get("requestContext") as { get(key: string): unknown };
  return String(context.get("requestId"));
}

function invalidAdminRequest(c: any): Response {
  return c.json({ error: "invalid_request", message: "提交的数据不完整或格式不正确。" }, 400);
}

const STUDIO_API_TOKEN_SCOPES = [
  "platform.background-tasks.read",
  "platform.catalog.read",
  "platform.internal-workflow.read",
  "platform.runtime.inspect",
  "platform.schedules.read",
] as const;

const HIDDEN_API_TOKEN_SCOPES = new Set([
  "qasey.task.execute",
  "qasey.e2e.execute",
  "qasey.case-workflow.execute",
  "qasey.scorers.read",
]);

export function availableApiTokenScopes(catalog: readonly CatalogEntry[]): readonly string[] {
  return [...new Set([
    ...STUDIO_API_TOKEN_SCOPES,
    ...catalog
      .filter(entry => entry.audiences.includes("api") && !entry.permission.startsWith("platform."))
      .map(entry => entry.permission)
      .filter(permission => !HIDDEN_API_TOKEN_SCOPES.has(permission)),
  ])].sort();
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
    owned("trigger-credential-rotation", "platform.triggers.manage", registerApiRoute("/admin/api/triggers/connections/:providerId/:id/rotate", {
      method: "POST",
      handler: async c => triggerMutation(c, options, "credential_rotation", async principal => {
        const input = z.object({ revision }).parse(await c.req.json());
        const connection = await options.triggerProviders.rotateCredentials(c.req.param("providerId"), {
          tenantId: principal.tenantId,
          actorId: principal.subjectId,
          id: c.req.param("id"),
          revision: input.revision,
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
