import type { Middleware } from "@mastra/core/server";
import type { CatalogEntry, RuntimeAudience } from "../../runtime/application.ts";
import type { AuditLog } from "./audit-log.ts";
import type { OAuthPrincipal } from "./oauth-principal.ts";
import type { PermissionService } from "./permission-store.ts";
import { conversationScope } from "../context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../context/schema.ts";
import { MASTRA_API_PREFIX, MASTRA_STUDIO_BASE, stripMastraApiPrefix } from "../../runtime/mastra-paths.ts";

export interface AuthorizationMiddlewareOptions {
  catalog: readonly CatalogEntry[];
  permissions: PermissionService;
  audit: AuditLog;
  studioUiEnabled?: boolean;
  resolvePrincipal(
    requestContext: { get(key: string): unknown; set(key: string, value: unknown): void },
    request: { raw: Request; path: string; method: string; header(name: string): string | undefined },
  ): OAuthPrincipal | undefined | Promise<OAuthPrincipal | undefined>;
}

interface ClassifiedResource {
  applicationId: string;
  resourceType: CatalogEntry["resourceType"] | "platform";
  resourceId: string;
  action: string;
  permission: string;
  audiences: readonly RuntimeAudience[];
  downstreamAuthenticated?: boolean;
  public?: boolean;
}

const PUBLIC_PATHS = [/\/healthz$/u, /\/readyz$/u];
export async function resolveRequestUser<T>(
  requestContext: { get(key: string): unknown; set(key: string, value: unknown): void },
  request: { raw: Request },
  isUser: (value: unknown) => value is T,
  provider?: { getCurrentUser(request: Request): Promise<T | null> },
): Promise<T | undefined> {
  const contextUser = requestContext.get("user");
  if (isUser(contextUser)) return contextUser;
  const sessionUser = await provider?.getCurrentUser(request.raw);
  if (!isUser(sessionUser)) return undefined;
  requestContext.set("user", sessionUser);
  return sessionUser;
}

export function classifyMastraStudioRoute(path: string, method: string): ClassifiedResource | undefined {
  const isStudioUiPath = (path === MASTRA_STUDIO_BASE || path.startsWith(`${MASTRA_STUDIO_BASE}/`))
    && path !== MASTRA_API_PREFIX
    && !path.startsWith(`${MASTRA_API_PREFIX}/`);
  if (method !== "GET" || !isStudioUiPath) return undefined;
  return {
    applicationId: "platform",
    resourceType: "platform",
    resourceId: "mastra-studio",
    action: "read",
    permission: "platform.runtime.inspect",
    audiences: ["admin-ui"],
  };
}

export function isMastraStudioRequest(request: {
  path: string;
  method: string;
  header(name: string): string | undefined;
}): boolean {
  if (request.header("x-mastra-client-type")?.toLowerCase() === "studio"
    || classifyMastraStudioRoute(request.path, request.method)) return true;
  const referer = request.header("referer");
  if (!referer) return false;
  try {
    return Boolean(classifyMastraStudioRoute(new URL(referer).pathname, "GET"));
  } catch {
    return false;
  }
}

export function createAuthorizationMiddleware(options: AuthorizationMiddlewareOptions): Middleware {
  const catalog = new Map(options.catalog.map(entry => [`${entry.resourceType}:${entry.resourceId}`, entry]));
  const routes = options.catalog.filter(entry => entry.resourceType === "route" && entry.routePath);
  return async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.some(pattern => pattern.test(path))) return next();
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    const requestContext = c.get("requestContext");
    const resource = classifyRuntimeRoute(path, c.req.method, catalog, routes)
      ?? (options.studioUiEnabled ? classifyMastraStudioRoute(path, c.req.method) : undefined);
    if (resource?.public) return next();
    const principal = await options.resolvePrincipal(requestContext, c.req);
    if (!principal && resource?.downstreamAuthenticated) {
      await options.audit.write(auditRecord(requestId, resource, undefined, "allow", "signed_channel_adapter"));
      requestContext.set("requestId", requestId);
      requestContext.set("applicationId", resource.applicationId);
      requestContext.set("ingressSource", "signed-channel-adapter");
      return next();
    }
    if (!principal) {
      await options.audit.write(auditRecord(requestId, resource, undefined, "deny", "anonymous"));
      return c.json({ error: "unauthorized", requestId }, 401);
    }
    if (!resource) {
      await options.audit.write({
        requestId, tenantId: principal.tenantId, subjectId: principal.subjectId,
        resourceType: "route", resourceId: path, action: c.req.method.toLowerCase(), decision: "deny", reason: "unclassified_route",
      });
      return c.json({ error: "not_found", requestId }, 404);
    }
    if (!resource.audiences.includes(principal.audience)) {
      await options.audit.write(auditRecord(requestId, resource, principal, "deny", "audience_denied"));
      return c.json({ error: "forbidden", requestId }, 403);
    }
    const allowed = await options.permissions.authorize({ principal, ...resource });
    await options.audit.write(auditRecord(requestId, resource, principal, allowed ? "allow" : "deny", allowed ? "permission_granted" : "permission_denied"));
    if (!allowed) return c.json({ error: "not_found", requestId }, 404);
    requestContext.set("platform-principal", principal);
    requestContext.set("requestId", requestId);
    requestContext.set("applicationId", resource.applicationId);
    requestContext.set("tenantId", principal.tenantId);
    requestContext.set("userId", principal.subjectId);
    const channel = principal.audience === "admin-ui" ? "web"
      : principal.audience === "channel" ? (path.includes("jira") ? "jira" : "slack")
        : principal.audience === "service" ? "worker" : "api";
    const scope = conversationScope({
      applicationId: resource.applicationId,
      tenantId: principal.tenantId,
      userId: principal.subjectId,
      conversationId: principal.subjectId,
      externalThreadId: principal.subjectId,
      kind: "private",
    });
    requestContext.set("channel", channel);
    requestContext.set("ingressSource", principal.audience);
    requestContext.set("sessionId", scope.threadId);
    requestContext.set(MASTRA_RESOURCE_ID_KEY, scope.resourceId);
    requestContext.set(MASTRA_THREAD_ID_KEY, scope.threadId);
    requestContext.set("identity", {
      userId: principal.subjectId,
      tenantId: principal.tenantId,
      roles: [...principal.roles],
      service: principal.service,
    });
    return next();
  };
}

export function classifyRuntimeRoute(
  path: string,
  method: string,
  catalog: ReadonlyMap<string, CatalogEntry>,
  routes: readonly CatalogEntry[],
): ClassifiedResource | undefined {
  const mastraPath = stripMastraApiPrefix(path);
  const channelWebhook = mastraPath
    ? /^\/agents\/([^/]+)\/channels\/([^/]+)\/webhook\/?$/u.exec(mastraPath)
    : null;
  if (channelWebhook) {
    const agent = catalog.get(`agent:${decodeURIComponent(channelWebhook[1]!)}`);
    const channel = catalog.get(`channel:${decodeURIComponent(channelWebhook[2]!)}`);
    if (!agent || !channel || agent.applicationId !== channel.applicationId) return undefined;
    return { ...channel, action: "receive", downstreamAuthenticated: true };
  }
  const primitive = mastraPath ? /^\/(agents|workflows|scorers)\/([^/]+)/u.exec(mastraPath) : null;
  if (primitive) {
    const resourceType = primitive[1] === "agents" ? "agent" : primitive[1] === "workflows" ? "workflow" : "scorer";
    const resourceId = decodeURIComponent(primitive[2]!);
    const entry = catalog.get(`${resourceType}:${resourceId}`);
    if (!entry) return undefined;
    return { ...entry, action: actionFor(method, path) };
  }
  if (mastraPath && /^\/(agents|workflows|scorers)\/?$/u.test(mastraPath)) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "catalog",
      action: "list", permission: "platform.catalog.read", audiences: ["admin-ui", "service"],
    };
  }
  if (mastraPath) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "runtime",
      action: actionFor(method, path), permission: "platform.runtime.inspect", audiences: ["admin-ui", "service"],
    };
  }
  const route = routes.find(entry => entry.routeMethod === method && routeMatches(entry.routePath!, path));
  if (route) return { ...route, action: actionFor(method, path) };
  return undefined;
}

function routeMatches(pattern: string, path: string): boolean {
  const escaped = pattern
    .split("/")
    .map(segment => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return new RegExp(`^(?:/api)?${escaped}/?$`, "u").test(path);
}

function actionFor(method: string, path: string): string {
  if (/\/(generate|stream|run|start|start-async|resume|restart|cancel|execute)(?:\/|$)/u.test(path)) return "execute";
  return method === "GET" ? "read" : "write";
}

function auditRecord(
  requestId: string,
  resource: ClassifiedResource | undefined,
  principal: OAuthPrincipal | undefined,
  decision: "allow" | "deny",
  reason: string,
) {
  return {
    requestId,
    ...(principal ? { tenantId: principal.tenantId, subjectId: principal.subjectId } : {}),
    ...(resource?.applicationId ? { applicationId: resource.applicationId } : {}),
    resourceType: resource?.resourceType ?? "route",
    resourceId: resource?.resourceId ?? "unknown",
    action: resource?.action ?? "access",
    decision,
    reason,
  } as const;
}
