import { registerDatadogContextBridge } from "./instrumentation.ts";
import { Mastra } from "@mastra/core/mastra";
import type { CustomSpanFormatter } from "@mastra/core/observability";
import { DatadogBridge } from "@mastra/datadog";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { RedisServerCache } from "@mastra/redis";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import Redis from "ioredis";
import { QASEY_TRACE_REQUEST_CONTEXT_KEYS } from "./applications/qasey/observability.ts";
import { applicationDatabase, closeQaseyInfrastructure, config, createMastraRuntimeStorage, credentialKeyring, e2eFixtureLeaseService, externalConnectionStore, failureInboxStore, initializeQaseyInfrastructure, runRepository, sandboxPoolClient } from "./runtime.ts";
import { createQaseyApplication } from "./applications/qasey/application.ts";
import * as e2eModule from "./workflows/e2e-workflow.ts";
import * as scorerModule from "./scorers/eval-scorers.ts";
import * as routeModule from "./applications/qasey/routes.ts";
import { createSharedMastraConfig } from "../runtime/create-runtime.ts";
import { createAuthorizationMiddleware, isMastraStudioRequest, isPublicRuntimePath, resolveRequestUser } from "../platform/auth/authorization-middleware.ts";
import { InMemoryAuditLog, PrismaAuditLog } from "../platform/auth/audit-log.ts";
import { InMemoryPermissionStore, PermissionService, PrismaPermissionStore } from "../platform/auth/permission-store.ts";
import { browserUserRoles, OAuthPrincipalSchema, createServicePrincipal, mapOAuthPrincipal } from "../platform/auth/oauth-principal.ts";
import { devRuntimeTunnelServerEnabled, resolveRedisDurabilityEnabled, verifyWebhookToken } from "../../packages/adapters/src/index.ts";
import { createScopedWorkspace } from "../platform/workspace/create-workspace.ts";
import { createAdminUiApplication } from "../platform/admin-ui/application.ts";
import { flattenApplicationRegistry } from "../runtime/registry-validator.ts";
import { LifecycleContainer } from "../platform/storage/lifecycle.ts";
import { sanitizeTelemetry } from "../platform/observability/sanitize.ts";
import { GoogleOidcService, type PlatformBrowserUser } from "../platform/auth/google-oidc.ts";
import { PasswordAuthService } from "../platform/auth/password-auth.ts";
import { MASTRA_API_PREFIX, MASTRA_STUDIO_BASE } from "../runtime/mastra-paths.ts";
import { closeDevelopmentConnections } from "../platform/http/development-connections.ts";
import { applyStudioNetworkPolicy } from "../platform/http/studio-network-policy.ts";
import { seedServiceRolePermissions } from "../platform/auth/service-role-permissions.ts";
import { installRuntimeLifecycle, runtimeReadiness } from "../platform/storage/readiness.ts";
import { startWorkerSupervisorHeartbeat } from "../worker/readiness-ipc.ts";
import { resolveDevelopmentPrincipal } from "../platform/auth/development-principal.ts";
import { InMemoryApiTokenStore, PrismaApiTokenStore } from "../platform/auth/api-token-store.ts";
import { GLOBAL_SKILLS_PATH } from "./skill-paths.ts";
import { startDevRuntimeTunnelClient } from "./applications/qasey/dev-runtime-client.ts";
import {
  QASEY_LOCAL_SLASH_COMMAND_SETUP,
  registerQaseySlackTunnelCommand,
} from "./applications/qasey/slack-tunnel-command.ts";
import {
  InMemorySlackInstallationRepository,
  PrismaSlackInstallationRepository,
} from "../platform/channels/slack-installation-repository.ts";
import { SlackIntegrationManager } from "../platform/channels/slack-integration-manager.ts";
import { ManagedSlackProvider } from "./managed-slack-provider.ts";
import { TriggerProviderRegistry } from "../platform/triggers/trigger-provider-registry.ts";
import { SlackTriggerProvider } from "../platform/triggers/slack-trigger-provider.ts";
import { StaleRunReconciler } from "../platform/recovery/failure-inbox.ts";
import { ReconcilerLoop } from "../platform/recovery/reconciler-loop.ts";
import { InMemoryOrganizationStore, PrismaOrganizationStore } from "../platform/auth/organization-store.ts";
import { createBrowserCsrfMiddleware } from "../platform/http/browser-csrf.ts";
import { createRequestTelemetryMiddleware } from "../platform/http/request-telemetry.ts";
import { productionSignals } from "../platform/observability/production-signals.ts";
import {
  createRequestBodyLimitMiddleware,
  createTrafficGovernanceMiddleware,
  InMemoryTrafficGovernanceStore,
  RedisTrafficGovernanceStore,
  type TrafficIdentity,
  type TrafficRequest,
} from "../platform/http/traffic-governance.ts";

function isBrowserUser(user: unknown): user is PlatformBrowserUser {
  return typeof user === "object" && user !== null
    && "id" in user && typeof user.id === "string"
    && "tenantId" in user && typeof user.tenantId === "string"
    && "sessionId" in user && typeof user.sessionId === "string"
    && "email" in user && typeof user.email === "string"
    && "emailVerified" in user && typeof user.emailVerified === "boolean"
    && "expiresAt" in user && typeof user.expiresAt === "string"
    && "authProvider" in user && (user.authProvider === "google" || user.authProvider === "password");
}

function organizationSlug(tenantId: string): string {
  const slug = tenantId.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/gu, "");
  if (!slug) throw new Error("QASEY_SINGLE_TENANT_ID must contain a letter or digit");
  return slug;
}

const EXPENSIVE_ROUTE_IDS = new Set([
  "qasey-task",
  "run-create",
  "run-rerun",
  "run-verdict",
  "sandbox-session-claim",
  "sandbox-browser-start",
  "sandbox-browser-action",
  "sandbox-desktop-start",
  "sandbox-desktop-action",
  "sandbox-desktop-tool",
  "sandbox-desktop-app",
]);

function trafficRequestContext(context: unknown): { get(key: string): unknown } | undefined {
  if (typeof context !== "object" || context === null || !("get" in context)
    || typeof context.get !== "function") return undefined;
  const requestContext = context.get("requestContext");
  return typeof requestContext === "object" && requestContext !== null && "get" in requestContext
    && typeof requestContext.get === "function"
    ? requestContext as { get(key: string): unknown }
    : undefined;
}

function resolveTrafficIdentity(context: unknown, request: TrafficRequest): TrafficIdentity | undefined {
  const requestContext = trafficRequestContext(context);
  const tenantId = requestContext?.get("tenantId");
  const subjectId = requestContext?.get("userId");
  if (typeof tenantId === "string" && typeof subjectId === "string") return { tenantId, subjectId };

  const routeId = requestContext?.get("platform-route-id");
  if (routeId === "slack") {
    const installationId = /^\/channels\/slack\/apps\/([^/]+)/u.exec(request.path)?.[1] ?? "unknown";
    const installationScope = installationId.slice(0, 256);
    // A Slack app installation is the pre-auth tenant boundary. Keeping it in
    // both quota dimensions prevents one customer's webhook burst from
    // consuming every installation's tenant budget before authorization.
    return {
      tenantId: `signed-channel:slack:${installationScope}`,
      subjectId: `installation:${installationScope}`,
    };
  }
  // Public OAuth/UI bootstrap routes and signed downstream adapters have no
  // platform principal yet. Give them a shared global tenant budget and a
  // per-route subject budget instead of silently exempting anonymous traffic.
  if (typeof routeId === "string" && routeId.length > 0) {
    return { tenantId: "pre-authenticated", subjectId: `route:${routeId}` };
  }
  return undefined;
}

function isExpensiveTrafficRequest(request: TrafficRequest, context: unknown): boolean {
  if (!["POST", "PUT", "PATCH"].includes(request.method.toUpperCase())) return false;
  const requestContext = trafficRequestContext(context);
  const resourceType = requestContext?.get("platform-resource-type");
  const routeId = requestContext?.get("platform-route-id");
  return resourceType === "agent" || resourceType === "workflow" || resourceType === "protocol"
    || typeof routeId === "string" && EXPENSIVE_ROUTE_IDS.has(routeId);
}

const formatDatadogSpan: CustomSpanFormatter = span => {
  const requestContext = span.requestContext ? {
    applicationId: span.requestContext.applicationId,
    requestId: span.requestContext.requestId,
    tenantId: span.requestContext.tenantId,
    userId: span.requestContext.userId,
    channel: span.requestContext.channel,
    sessionId: span.requestContext.sessionId,
    threadId: span.requestContext.mastra__threadId,
    taskId: span.requestContext.taskId,
  } : undefined;
  return sanitizeTelemetry({
    ...span,
    ...(requestContext ? { requestContext } : {}),
    ...(config.QASEY_DATADOG_CAPTURE_CONTENT ? {} : { input: undefined, output: undefined }),
  }, {
    captureModelContent: config.QASEY_DATADOG_CAPTURE_CONTENT,
  }) as typeof span;
};

const datadogBridge = config.QASEY_ENABLE_DATADOG
  ? new DatadogBridge({
      mlApp: config.DD_LLMOBS_ML_APP!,
      site: config.DD_SITE,
      ...(config.DD_API_KEY ? { apiKey: config.DD_API_KEY } : {}),
      service: config.DD_SERVICE,
      env: config.DD_ENV ?? config.NODE_ENV,
      agentless: config.DD_LLMOBS_AGENTLESS_ENABLED,
      requestContextKeys: ["applicationId", "requestId", "tenantId", "userId", "sessionId", "mastra__threadId", "taskId", "channel"],
      customSpanFormatter: formatDatadogSpan,
    })
  : undefined;
registerDatadogContextBridge(datadogBridge);

const permissionStore = config.NODE_ENV === "production" && config.DATABASE_URL
  ? new PrismaPermissionStore(applicationDatabase!.client)
  : new InMemoryPermissionStore();
const permissionService = new PermissionService(permissionStore);
const organizationStore = config.NODE_ENV !== "test" && config.DATABASE_URL
  ? new PrismaOrganizationStore(applicationDatabase!.client)
  : new InMemoryOrganizationStore();
const authorizeApiTokenUse = async (record: { tenantId: string; createdBy: string }) => config.NODE_ENV !== "production"
  || Boolean(await organizationStore.resolveActiveMembership(record.tenantId, record.createdBy));
const apiTokenStore = config.NODE_ENV === "production" && config.DATABASE_URL
  ? new PrismaApiTokenStore(applicationDatabase!.client, authorizeApiTokenUse)
  : new InMemoryApiTokenStore(authorizeApiTokenUse);
const auditLog = config.NODE_ENV === "production" && config.DATABASE_URL
  ? new PrismaAuditLog(applicationDatabase!.client)
  : new InMemoryAuditLog();
const slackInstallationRepository = config.NODE_ENV === "production" && config.DATABASE_URL
  ? new PrismaSlackInstallationRepository(applicationDatabase!.client, credentialKeyring)
  : new InMemorySlackInstallationRepository(credentialKeyring);
const slackIntegrations = new SlackIntegrationManager(
  slackInstallationRepository,
  config.QASEY_PUBLIC_BASE_URL,
  [{ applicationId: "qasey", agentId: "qasey-main", name: "Qasey" }],
);
const managedSlackProvider = new ManagedSlackProvider(slackIntegrations, {
  onBridgeReady: ({ mastra, channels, installation }) => installation.devRuntimeEnabled
    ? registerQaseySlackTunnelCommand(mastra, channels, installation.devRuntimeCommand)
    : undefined,
});
const triggerProviders = new TriggerProviderRegistry([
  new SlackTriggerProvider(
    slackIntegrations,
    installationId => managedSlackProvider.invalidate(installationId),
    devRuntimeTunnelServerEnabled(config) ? { slashCommand: QASEY_LOCAL_SLASH_COMMAND_SETUP } : {},
  ),
]);
runtimeReadiness.register("permission-store", () => permissionStore.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("api-token-store", () => apiTokenStore.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("organization-store", () => organizationStore.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("audit-log", () => auditLog.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("slack-installations", () => slackInstallationRepository.healthCheck?.() ?? Promise.resolve());
await Promise.all([
  initializeQaseyInfrastructure(),
  permissionStore.init?.(),
  apiTokenStore.init?.(),
  organizationStore.init?.(),
  auditLog.init?.(),
  slackInstallationRepository.init?.(),
]);
const singleTenantId = config.QASEY_TENANCY_MODE === "single"
  ? config.QASEY_SINGLE_TENANT_ID ?? (config.NODE_ENV === "production" ? undefined : "local")
  : undefined;
if (config.QASEY_TENANCY_MODE === "single" && !singleTenantId) {
  throw new Error("Single-tenant browser login requires QASEY_SINGLE_TENANT_ID");
}
if (singleTenantId) {
  await organizationStore.ensureOrganization({
    id: singleTenantId,
    slug: organizationSlug(singleTenantId),
    displayName: singleTenantId,
  });
}
const bootstrapAdmins = new Set((process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS ?? "")
  .split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
const localAdmins = new Set((config.PLATFORM_LOCAL_ADMIN_EMAILS ?? [])
  .map(value => value.toLowerCase()));
const googleOidc = new GoogleOidcService({
  ...(config.GOOGLE_CLIENT_ID ? { clientId: config.GOOGLE_CLIENT_ID } : {}),
  ...(config.GOOGLE_CLIENT_SECRET ? { clientSecret: config.GOOGLE_CLIENT_SECRET } : {}),
  callbackUrl: config.GOOGLE_REDIRECT_URI ?? `${config.QASEY_PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/google/callback`,
  ...(config.GOOGLE_COOKIE_PASSWORD ? { cookiePassword: config.GOOGLE_COOKIE_PASSWORD } : {}),
  ...(config.GOOGLE_ALLOWED_DOMAINS ? { allowedDomains: config.GOOGLE_ALLOWED_DOMAINS } : {}),
  ...(config.GOOGLE_HOSTED_DOMAIN ? { hostedDomain: config.GOOGLE_HOSTED_DOMAIN } : {}),
  secureCookies: config.NODE_ENV === "production",
  organizationStore,
  tenancy: config.QASEY_TENANCY_MODE === "single"
    ? { mode: "single", organizationId: singleTenantId! }
    : { mode: "multi" },
  bootstrapMembershipEmails: [...bootstrapAdmins],
  allowSessionOrganization: (organizationId, userId) => e2eFixtureLeaseService.isActiveFixtureUser(organizationId, userId),
});
const passwordAuth = new PasswordAuthService({
  enabled: config.QASEY_PASSWORD_AUTH_ENABLED === true && config.QASEY_TENANCY_MODE === "single",
  registrationEnabled: config.QASEY_PASSWORD_REGISTRATION_ENABLED === true
    && config.QASEY_TENANCY_MODE === "single",
  ...(singleTenantId ? { organizationId: singleTenantId } : {}),
  organizationStore,
  secureCookies: config.NODE_ENV === "production",
});
await seedServiceRolePermissions(permissionService, config.QASEY_SINGLE_TENANT_ID ?? "trusted-ingress");
const staleRunReconciler = new StaleRunReconciler(runRepository, failureInboxStore, config.QASEY_RUN_HEARTBEAT_TIMEOUT_MS);
const runReconcilerLoop = config.QASEY_DEPLOYMENT_MODE === "standalone" || config.MASTRA_WORKERS === "orchestration"
  ? new ReconcilerLoop(
      () => staleRunReconciler.runOnce().then(() => undefined),
      config.QASEY_RUN_RECONCILER_INTERVAL_MS,
      error => console.error(JSON.stringify({ event: "run.reconciler.failed", message: error.message })),
    ).start()
  : undefined;
if (runReconcilerLoop) runtimeReadiness.register("run-reconciler", () => runReconcilerLoop.healthCheck());
const qaseyApplication = createQaseyApplication({
  e2eModule,
  scorerModule,
  routeModule,
});
const qaseyCatalog = flattenApplicationRegistry([qaseyApplication]).catalog;
const adminUiApplication = createAdminUiApplication({
  publicBaseUrl: config.QASEY_PUBLIC_BASE_URL,
  applicationCatalog: qaseyCatalog,
  applications: [qaseyApplication],
  permissions: permissionService,
  audit: auditLog,
  googleOidc,
  passwordAuth,
  apiTokens: apiTokenStore,
  organizations: organizationStore,
  triggerProviders,
  externalConnections: externalConnectionStore,
  failureRecovery: {
    failures: failureInboxStore,
    runs: runRepository,
    createRedrive: (owner, sourceRunId, runtime) => e2eModule.rerunE2E(
      runtime.mastra,
      owner,
      sourceRunId,
      runtime.requestContext,
      runtime.actorId,
    ),
  },
});
const lifecycle = new LifecycleContainer();
lifecycle.own({ close: closeQaseyInfrastructure });
if (runReconcilerLoop) lifecycle.own(runReconcilerLoop);
if (permissionStore.close) lifecycle.own({ close: () => permissionStore.close!() });
if (apiTokenStore.close) lifecycle.own({ close: () => apiTokenStore.close!() });
if (organizationStore.close) lifecycle.own({ close: () => organizationStore.close!() });
if (auditLog.close) lifecycle.own({ close: () => auditLog.close!() });
if (slackInstallationRepository.close) lifecycle.own({ close: () => slackInstallationRepository.close!() });
lifecycle.own(managedSlackProvider);
const remoteSandboxPool = sandboxPoolClient;
const workspace = lifecycle.own(createScopedWorkspace({
  root: config.QASEY_WORKSPACE_DIR,
  production: config.NODE_ENV === "production",
  enableCodeExecution: config.QASEY_ENABLE_LOCAL_CODE_MODE || Boolean(remoteSandboxPool),
  skills: [GLOBAL_SKILLS_PATH],
  ...(remoteSandboxPool ? {
    remoteFilesystem: scope => remoteSandboxPool.filesystem(scope),
    remoteSandbox: scope => remoteSandboxPool.sandbox(scope),
  } : {}),
}));
const redisKeyPrefix = `qasey:${config.QASEY_DEPLOYMENT_ID ?? config.NODE_ENV}`;
const redisDurabilityEnabled = resolveRedisDurabilityEnabled(config);
const redisHost = redisDurabilityEnabled ? config.REDIS_HOST : undefined;
const redisUrl = redisHost
  ? `${config.REDIS_TLS ? "rediss" : "redis"}://${redisHost}:${config.REDIS_PORT ?? 6379}`
  : undefined;
const pubsub = redisHost
  ? new RedisStreamsPubSub({
      url: redisUrl!,
      keyPrefix: redisKeyPrefix,
      redisOptions: {
        ...(config.REDIS_USERNAME ? { username: config.REDIS_USERNAME } : {}),
        ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
        socket: {
          host: redisHost,
          port: config.REDIS_PORT ?? 6379,
          ...(config.REDIS_TLS ? {
            tls: true as const,
            ...(config.REDIS_TLS_SERVERNAME ? { servername: config.REDIS_TLS_SERVERNAME } : {}),
          } : {}),
        },
      },
    })
  : undefined;
const cacheClient = redisHost
  ? new Redis({
      host: redisHost,
      port: config.REDIS_PORT ?? 6379,
      ...(config.REDIS_USERNAME ? { username: config.REDIS_USERNAME } : {}),
      ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
      ...(config.REDIS_TLS ? {
        tls: {
          ...(config.REDIS_TLS_SERVERNAME ? { servername: config.REDIS_TLS_SERVERNAME } : {}),
        },
      } : {}),
      maxRetriesPerRequest: 3,
    })
  : undefined;
if (cacheClient) {
  runtimeReadiness.register("redis", async () => {
    if (await cacheClient.ping() !== "PONG") throw new Error("Redis readiness check did not return PONG");
  });
  lifecycle.own({ close: async () => { await cacheClient.quit(); } });
}
const cache = cacheClient
  ? new RedisServerCache({ client: cacheClient }, { keyPrefix: `${redisKeyPrefix}:cache` })
  : undefined;
const trafficStore = cacheClient
  ? new RedisTrafficGovernanceStore(cacheClient)
  : new InMemoryTrafficGovernanceStore();

// Mastra CLI statically extracts a top-level `server` binding before starting
// the dev server. Keep this base config side-effect free so that extraction
// does not initialize the rest of the runtime merely to discover its paths.
const server = {
  studioBase: MASTRA_STUDIO_BASE,
  apiPrefix: MASTRA_API_PREFIX,
  cors: { origin: [], allowMethods: ["GET", "POST"], allowHeaders: ["content-type", "authorization", "x-qasey-webhook-token", "x-qasey-runtime-instance"] },
};
const sharedRuntime = createSharedMastraConfig({
  applications: [qaseyApplication, adminUiApplication],
  platform: {
    storage: createMastraRuntimeStorage(),
    ...(pubsub ? { pubsub } : {}),
    ...(cache ? { cache } : {}),
    observability: new Observability({
    configs: {
      default: {
        serviceName: "shared-mastra-runtime",
        logging: { enabled: true, level: "info" },
        requestContextKeys: [
          "applicationId", "requestId", "tenantId", "userId", "channel", "ingressSource", "sessionId",
          "mastra__resourceId", "mastra__threadId", "externalWriteIdempotencyKey", ...QASEY_TRACE_REQUEST_CONTEXT_KEYS,
        ],
        ...(datadogBridge ? { bridge: datadogBridge } : {}),
        exporters: [new MastraStorageExporter()],
      },
    },
    }),
    environment: config.NODE_ENV,
    workspace,
  },
  server,
  middlewareFactory: catalog => {
    const requestBodyLimit = createRequestBodyLimitMiddleware(config.QASEY_REQUEST_BODY_MAX_BYTES);
    const requestTelemetry = createRequestTelemetryMiddleware({
      observe: input => productionSignals.observeHttpRequest(input),
    });
    const authorization = createAuthorizationMiddleware({
      catalog,
      permissions: permissionService,
      audit: auditLog,
      // Studio is available in every environment; OAuth, RBAC, and audit remain
      // the security boundary. High-risk Editor/MCP features stay separately gated.
      studioUiEnabled: true,
      resolvePrincipal: async (requestContext, request) => {
        const user = await resolveRequestUser(requestContext, request, isBrowserUser, googleOidc);
        if (user) {
          // Email/hosted domains are authentication attributes, never tenant
          // authorization. Multi-tenant mode resolves an explicit membership
          // below once the organization store is initialized.
          const tenantId = user.tenantId;
          if (config.QASEY_TENANCY_MODE === "single" && tenantId !== singleTenantId
            && !await e2eFixtureLeaseService.isActiveFixtureUser(tenantId, user.id)) return undefined;
          const roles = browserUserRoles(user, bootstrapAdmins, localAdmins);
          if (permissionStore instanceof InMemoryPermissionStore) {
            permissionStore.grant(
              tenantId,
              "user",
              "platform.admin-ui.access",
              "qasey.agent.execute",
              "qasey.e2e.execute",
              "qasey.runs.read",
              "qasey.runs.write",
              "qasey.cases.read",
              "qasey.cases.write",
              "qasey.results.read",
              "qasey.results.approve",
              "qasey.sandbox.use",
            );
          }
          return mapOAuthPrincipal(user, {
            subjectId: value => value.id,
            tenantId: () => tenantId,
            roles: () => roles,
            email: value => value.email,
            audience: request.path.startsWith("/admin") || isMastraStudioRequest(request) ? "admin-ui" : "api",
          });
        }
        const developmentPrincipal = resolveDevelopmentPrincipal({
          nodeEnv: config.NODE_ENV,
          configuredToken: config.QASEY_DEV_AUTH_TOKEN,
          authorization: request.header("authorization"),
          audience: request.path.startsWith("/admin") || isMastraStudioRequest(request) ? "admin-ui" : "api",
        });
        if (developmentPrincipal) return developmentPrincipal;
        const presentedBearer = request.header("authorization")?.match(/^Bearer\s+([^\s]+)$/iu)?.[1];
        if (presentedBearer) {
          const apiTokenPrincipal = await apiTokenStore.authenticate(presentedBearer);
          if (apiTokenPrincipal) return apiTokenPrincipal;
        }
        const ingressToken = request.header("authorization")?.replace(/^Bearer\s+/iu, "")
          ?? request.header("x-qasey-webhook-token");
        const jiraIngress = request.path.includes("jira");
        const workerIngress = !jiraIngress && verifyWebhookToken(ingressToken, config.WORKER_TOKEN);
        const platformIngress = !jiraIngress && verifyWebhookToken(ingressToken, config.PLATFORM_SERVICE_TOKEN);
        if (jiraIngress ? !verifyWebhookToken(ingressToken, config.JIRA_WEBHOOK_TOKEN) : !workerIngress && !platformIngress) {
          return undefined;
        }
        const tenantId = config.QASEY_SINGLE_TENANT_ID ?? "trusted-ingress";
        const role = jiraIngress ? "qasey-ingress" : workerIngress ? "orchestration-worker" : "platform-service";
        const service = createServicePrincipal({ subjectId: role, tenantId, roles: [role] });
        return jiraIngress ? OAuthPrincipalSchema.parse({ ...service, audience: "channel" }) : service;
      },
    });
    const trafficGovernance = createTrafficGovernanceMiddleware({
      store: trafficStore,
      keyPrefix: `${redisKeyPrefix}:traffic`,
      limits: {
        requestBodyMaxBytes: config.QASEY_REQUEST_BODY_MAX_BYTES,
        standard: {
          tenantLimit: config.QASEY_STANDARD_TENANT_REQUESTS_PER_MINUTE,
          subjectLimit: config.QASEY_STANDARD_SUBJECT_REQUESTS_PER_MINUTE,
          windowMs: 60_000,
        },
        expensive: {
          tenantLimit: config.QASEY_EXPENSIVE_TENANT_REQUESTS_PER_MINUTE,
          subjectLimit: config.QASEY_EXPENSIVE_SUBJECT_REQUESTS_PER_MINUTE,
          windowMs: 60_000,
          tenantConcurrency: config.QASEY_EXPENSIVE_TENANT_CONCURRENCY,
          leaseTtlMs: config.QASEY_EXPENSIVE_LEASE_TTL_MS,
        },
      },
      resolveIdentity: resolveTrafficIdentity,
      isPublicRequest: request => isPublicRuntimePath(request.path, request.method, true),
      isExpensiveRequest: isExpensiveTrafficRequest,
      onRejected: input => productionSignals.incrementTrafficRejected(input),
      onStoreError: (_error, operation) => {
        productionSignals.incrementTrafficStoreError(operation);
        console.error(JSON.stringify({ event: "traffic.governance.store_error", operation }));
      },
    });
    const browserCsrf = createBrowserCsrfMiddleware({ publicBaseUrl: config.QASEY_PUBLIC_BASE_URL });
    return config.NODE_ENV === "development"
      ? [requestBodyLimit, requestTelemetry, closeDevelopmentConnections, authorization, trafficGovernance, browserCsrf, applyStudioNetworkPolicy]
      : [requestBodyLimit, requestTelemetry, authorization, trafficGovernance, browserCsrf, applyStudioNetworkPolicy];
  },
});
// The shared runtime adds registered routes and authorization middleware.
Object.assign(server, sharedRuntime.config.server!);

export const mastra = new Mastra({
  ...sharedRuntime.config,
  channels: { slack: managedSlackProvider },
  server,
  recovery: { durableAgents: "auto" },
  bundler: {
    externals: [
      // Prisma's generated client and driver adapter load native/runtime files
      // from node_modules and must remain external in the Mastra worker bundle.
      "@prisma",
      "@duckdb/node-bindings",
      "dd-trace",
      "@datadog/native-metrics",
      "@datadog/native-appsec",
      "@datadog/native-iast-taint-tracking",
      "@datadog/pprof",
      // QuickJS Code Mode erases model-authored TypeScript with this pure-JS
      // package. Mastra's Worker bundler cannot inline it reliably.
      "ts-blank-space",
    ],
  },
});
// Mastra's generated entry registers file-based agents after this module has
// evaluated. Start registration without a top-level await so qasey-main can be
// injected, and expose failures through readiness instead of crashing during
// module evaluation with MASTRA_GET_AGENT_BY_NAME_NOT_FOUND.
const qaseySlackTunnelCommandRegistration = registerQaseySlackTunnelCommand(mastra);
if (devRuntimeTunnelServerEnabled(config)) {
  runtimeReadiness.register("slack-tunnel-command", () => qaseySlackTunnelCommandRegistration);
  void qaseySlackTunnelCommandRegistration.catch(error => {
    mastra.getLogger().error("Failed to register /qasey-local", error);
  });
}
const devRuntimeTunnelClient = startDevRuntimeTunnelClient(mastra, config);
if (devRuntimeTunnelClient) lifecycle.own({ close: () => devRuntimeTunnelClient.close() });
export const applicationCatalog = sharedRuntime.catalog;
export const closeRuntime = (): Promise<void> => lifecycle.close();
runtimeReadiness.markInitializationComplete();
const workerSupervisorHeartbeat = config.MASTRA_WORKERS === "orchestration"
  ? startWorkerSupervisorHeartbeat(() => runtimeReadiness.inspect())
  : undefined;
if (workerSupervisorHeartbeat) lifecycle.own(workerSupervisorHeartbeat);
installRuntimeLifecycle({
  target: mastra,
  role: config.MASTRA_WORKERS === "orchestration" ? "worker" : "api",
  readiness: runtimeReadiness,
  closeRuntime,
});
