import type { Middleware } from "@mastra/core/server";
import type { CatalogEntry, RuntimeAudience } from "../../runtime/application.ts";
import type { AuditLog } from "./audit-log.ts";
import type { OAuthPrincipal } from "./oauth-principal.ts";
import type { PermissionService } from "./permission-store.ts";
import { conversationScope } from "../context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY } from "../context/schema.ts";
import { MASTRA_API_PREFIX, MASTRA_STUDIO_BASE, stripMastraApiPrefix } from "../../runtime/mastra-paths.ts";

export interface AuthorizationMiddlewareOptions {
  catalog: readonly CatalogEntry[];
  permissions: PermissionService;
  audit: AuditLog;
  studioUiEnabled?: boolean;
  resolvePrincipal(
    requestContext: { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void },
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
export function isPublicRuntimePath(path: string, method: string, studioUiEnabled = false): boolean {
  return PUBLIC_PATHS.some(pattern => pattern.test(path))
    || (studioUiEnabled && method === "GET" && path === "/");
}

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

export function studioLoginRedirect(request: {
  raw: Request;
  path: string;
  method: string;
  header(name: string): string | undefined;
}): string | undefined {
  if (!classifyMastraStudioRoute(request.path, request.method)) return undefined;
  const acceptsHtml = request.header("accept")?.toLowerCase().includes("text/html") ?? false;
  const documentNavigation = request.header("sec-fetch-dest")?.toLowerCase() === "document";
  if (!acceptsHtml && !documentNavigation) return undefined;
  const originalUrl = new URL(request.raw.url);
  const redirectUri = `${request.path}${originalUrl.search}`;
  return `/admin?${new URLSearchParams({ redirect_uri: redirectUri })}`;
}

function isPlatformAdminWorkflowRunAccess(
  request: { path: string; method: string },
  principal: OAuthPrincipal,
  studioRequest: boolean,
): boolean {
  if (!studioRequest || principal.audience !== "admin-ui" || !principal.roles.includes("platform-admin")) return false;
  const mastraPath = stripMastraApiPrefix(request.path);
  if (!mastraPath) return false;
  if (request.method === "GET") return /^\/workflows\/[^/]+\/runs(?:\/[^/]+)?\/?$/u.test(mastraPath);
  return request.method === "POST" && /^\/workflows\/[^/]+\/runs\/[^/]+\/cancel\/?$/u.test(mastraPath);
}

async function applicationIdForRequestScope(
  request: { raw: Request; path: string },
  fallback: string,
  catalog: ReadonlyMap<string, CatalogEntry>,
): Promise<string> {
  const mastraPath = stripMastraApiPrefix(request.path);
  if (!mastraPath) return fallback;
  if (/^\/workflows\/run-counts\/?$/u.test(mastraPath)) {
    const applicationIds = new Set(
      [...catalog.values()]
        .filter(entry => entry.resourceType === "workflow")
        .map(entry => entry.applicationId),
    );
    return applicationIds.size === 1 ? [...applicationIds][0]! : fallback;
  }
  if (!/^\/memory(?:\/|$)/u.test(mastraPath)) return fallback;

  const url = new URL(request.raw.url);
  let agentId = url.searchParams.get("agentId");
  if (!agentId && request.raw.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await request.raw.clone().json() as { agentId?: unknown };
      if (typeof body.agentId === "string") agentId = body.agentId;
    } catch {
      // Route validation owns malformed-body errors; scope resolution simply
      // falls back to the classified route until a valid agent id exists.
    }
  }
  return (agentId ? catalog.get(`agent:${agentId}`)?.applicationId : undefined) ?? fallback;
}

async function agentResourceForProtocolRequest(
  request: { raw: Request },
  protocol: ClassifiedResource,
  catalog: ReadonlyMap<string, CatalogEntry>,
): Promise<ClassifiedResource | undefined> {
  if (request.raw.method !== "POST" || !request.raw.headers.get("content-type")?.includes("application/json")) {
    return protocol;
  }
  try {
    const body = await request.raw.clone().json() as { agent_id?: unknown };
    if (body.agent_id === undefined) return protocol;
    if (typeof body.agent_id !== "string") return undefined;
    const agent = catalog.get(`agent:${body.agent_id}`);
    if (!agent || agent.applicationId !== protocol.applicationId) return undefined;
    return { ...agent, action: "execute" };
  } catch {
    // The route schema will return the detailed malformed-body response.
    return protocol;
  }
}

export function createAuthorizationMiddleware(options: AuthorizationMiddlewareOptions): Middleware {
  const catalog = new Map(options.catalog.map(entry => [`${entry.resourceType}:${entry.resourceId}`, entry]));
  const routes = options.catalog.filter(entry => entry.resourceType === "route" && entry.routePath);
  return async (c, next) => {
    const path = c.req.path;
    // Studio probes the instance root before it applies the injected API
    // prefix. Expose that welcome route only while the development UI is on.
    if (isPublicRuntimePath(path, c.req.method, options.studioUiEnabled)) return next();
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    const requestContext = c.get("requestContext");
    const classified = classifyRuntimeRoute(path, c.req.method, catalog, routes)
      ?? (options.studioUiEnabled ? classifyMastraStudioRoute(path, c.req.method) : undefined);
    const resource = classified?.resourceType === "protocol"
      ? await agentResourceForProtocolRequest(c.req, classified, catalog)
      : classified;
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
      const loginRedirect = options.studioUiEnabled ? studioLoginRedirect(c.req) : undefined;
      if (loginRedirect) return c.redirect(loginRedirect, 302);
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
    const scopeApplicationId = await applicationIdForRequestScope(c.req, resource.applicationId, catalog);
    requestContext.set("platform-principal", principal);
    requestContext.set("requestId", requestId);
    requestContext.set("applicationId", scopeApplicationId);
    requestContext.set("tenantId", principal.tenantId);
    requestContext.set("userId", principal.subjectId);
    const channel = principal.audience === "admin-ui" ? "web"
      : principal.audience === "channel" ? (path.includes("jira") ? "jira" : "slack")
        : principal.audience === "service" ? "worker" : "api";
    const scope = conversationScope({
      applicationId: scopeApplicationId,
      tenantId: principal.tenantId,
      userId: principal.subjectId,
      conversationId: principal.subjectId,
      externalThreadId: principal.subjectId,
      kind: "private",
    });
    requestContext.set("channel", channel);
    const studioRequest = isMastraStudioRequest(c.req);
    requestContext.set("ingressSource", studioRequest ? "mastra-studio" : principal.audience);
    requestContext.set("sessionId", scope.threadId);
    if (isPlatformAdminWorkflowRunAccess(c.req, principal, studioRequest)) {
      // Mastra gives its server-derived resource id precedence over the
      // resourceId query parameter. Leaving the authenticated user's private
      // scope here would hide Slack/Jira runs from platform admins, reject
      // their detail pages, and prevent canceling a run selected in Studio.
      // Only un-scope run history/detail and the existing-run cancel action;
      // new executions, other workflow controls, and every non-admin request
      // retain the normal owner boundary. Mastra resolves cancel by run id,
      // validates the persisted run, then recreates it with its stored owner.
      if (requestContext.delete) requestContext.delete(MASTRA_RESOURCE_ID_KEY);
      else requestContext.set(MASTRA_RESOURCE_ID_KEY, undefined);
    } else {
      requestContext.set(MASTRA_RESOURCE_ID_KEY, scope.resourceId);
    }
    // Authentication owns the resource boundary, not the conversation
    // lifecycle. Ingress adapters that need a stable conversation (Slack,
    // Jira, etc.) set MASTRA_THREAD_ID_KEY themselves. Agent APIs and Studio
    // may then create or select a thread without authentication silently
    // collapsing every request for the user into one history.
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
  if (method === "POST" && /^\/channels\/slack\/apps\/[^/]+\/events\/?$/u.test(path)) {
    return {
      applicationId: "qasey", resourceType: "channel", resourceId: "slack",
      action: "receive", permission: "qasey.channel.receive", audiences: ["channel"],
      downstreamAuthenticated: true,
    };
  }
  const mastraPath = stripMastraApiPrefix(path);
  // Mastra's scheduler is a platform management surface: its GET routes read
  // global rows, while POST/PATCH/DELETE can mutate or execute them. Classify
  // every operation instead of turning the entire feature into a synthetic
  // 404. These permissions are intentionally not granted to tenant roles;
  // PermissionService's platform-admin bypass is the control-plane boundary.
  if (mastraPath && /^\/schedules(?:\/|$)/u.test(mastraPath)) {
    const action = method === "DELETE" ? "delete" : actionFor(method, path);
    const permission = method === "GET"
      ? "platform.schedules.read"
      : method === "DELETE"
        ? "platform.schedules.delete"
        : /\/(?:run|pause|resume)\/?$/u.test(mastraPath)
          ? "platform.schedules.execute"
          : "platform.schedules.write";
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "schedules",
      action, permission, audiences: ["admin-ui", "api", "service"],
    };
  }
  // Background-task HTTP handlers are read-only in the pinned Mastra server.
  // They expose global operational state, so keep them platform-admin-only via
  // an ungranted platform permission rather than rejecting legitimate Studio
  // polling before RBAC gets a chance to decide.
  if (mastraPath && method === "GET" && /^\/background-tasks(?:\/|$)/u.test(mastraPath)) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "background-tasks",
      action: "read", permission: "platform.background-tasks.read", audiences: ["admin-ui", "api", "service"],
    };
  }
  const channelWebhook = mastraPath
    ? /^\/agents\/([^/]+)\/channels\/([^/]+)\/webhook\/?$/u.exec(mastraPath)
    : null;
  if (channelWebhook) {
    const agent = catalog.get(`agent:${decodeURIComponent(channelWebhook[1]!)}`);
    const channel = catalog.get(`channel:${decodeURIComponent(channelWebhook[2]!)}`);
    if (!agent || !channel || agent.applicationId !== channel.applicationId) return undefined;
    return { ...channel, action: "receive", downstreamAuthenticated: true };
  }
  // Mastra exposes collection-level routes below a primitive namespace. Match
  // those before `/:resourceId`, otherwise `/agents/providers` is interpreted
  // as an Agent whose id is `providers` and is hidden behind a misleading 404.
  if (mastraPath && method === "GET" && /^\/agents\/providers\/?$/u.test(mastraPath)) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "runtime",
      action: actionFor(method, path), permission: "platform.runtime.inspect", audiences: ["admin-ui", "service"],
    };
  }
  if (mastraPath && method === "GET" && /^\/workflows\/run-counts\/?$/u.test(mastraPath)) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "workflow-catalog",
      action: "read", permission: "platform.catalog.read", audiences: ["admin-ui", "service"],
    };
  }
  if (mastraPath && /^\/workflows\/events\/?$/u.test(mastraPath)) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "workflow-events",
      action: "execute", permission: "platform.workflow-events.receive", audiences: ["service"],
    };
  }
  const protocol = mastraPath ? /^\/v1\/(conversations|responses)(?:\/|$)/u.exec(mastraPath) : null;
  if (protocol) {
    const resourceIdSuffix = `:${protocol[1]}`;
    const entries = [...catalog.values()].filter(entry =>
      entry.resourceType === "protocol" && entry.resourceId.endsWith(resourceIdSuffix),
    );
    if (entries.length !== 1) return undefined;
    return { ...entries[0]!, action: actionFor(method, path) };
  }
  const primitive = mastraPath ? /^\/(agents|workflows|scorers)\/([^/]+)/u.exec(mastraPath) : null;
  if (primitive) {
    const resourceType = primitive[1] === "agents" ? "agent" : primitive[1] === "workflows" ? "workflow" : "scorer";
    const resourceId = decodeURIComponent(primitive[2]!);
    const entry = catalog.get(`${resourceType}:${resourceId}`);
    // Mastra registers framework-owned workflows (for example an Agent's
    // durable loop) in its runtime catalog. They correctly appear in Studio,
    // but are not business workflows and therefore do not belong in an app's
    // authorization catalog. Let platform admins inspect and operate any such
    // upstream-validated workflow; typos still become Mastra's own 404.
    if (!entry && resourceType === "workflow") {
      const action = actionFor(method, path);
      return {
        applicationId: "platform", resourceType: "platform", resourceId: `workflow:${resourceId}`,
        action,
        permission: method === "GET" ? "platform.internal-workflow.read" : "platform.internal-workflow.manage",
        audiences: ["admin-ui", "api", "service"],
      };
    }
    if (!entry) return undefined;
    return { ...entry, action: actionFor(method, path) };
  }
  if (mastraPath && /^\/(agents|workflows|scorers)\/?$/u.test(mastraPath)) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "catalog",
      action: method === "GET" ? "list" : "write",
      permission: method === "GET" ? "platform.catalog.read" : "platform.catalog.manage",
      audiences: ["admin-ui", "api", "service"],
    };
  }
  if (mastraPath) {
    return {
      applicationId: "platform", resourceType: "platform", resourceId: "runtime",
      action: actionFor(method, path),
      permission: method === "GET" ? "platform.runtime.inspect" : "platform.runtime.manage",
      audiences: ["admin-ui", "api", "service"],
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
