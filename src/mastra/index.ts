import "./instrumentation.ts";
import { Mastra } from "@mastra/core/mastra";
import type { CustomSpanFormatter } from "@mastra/core/observability";
import { DatadogBridge } from "@mastra/datadog";
import { MastraEditor } from "@mastra/editor";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { RedisServerCache } from "@mastra/redis";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import Redis from "ioredis";
import { QASEY_TRACE_REQUEST_CONTEXT_KEYS } from "./applications/qasey/observability.ts";
import { closeQaseyInfrastructure, config, createMastraRuntimeStorage, initializeQaseyInfrastructure, sandboxPoolClient, studioEditorEnabled } from "./runtime.ts";
import { createQaseyApplication } from "./applications/qasey/application.ts";
import * as taskWorkflowModule from "./workflows/qasey-task-workflow.ts";
import * as e2eModule from "./workflows/e2e-workflow.ts";
import * as scorerModule from "./scorers/eval-scorers.ts";
import * as caseWorkflowModule from "./workflows/metersphere-case-workflow.ts";
import * as routeModule from "./applications/qasey/routes.ts";
import { createSharedMastraConfig } from "../runtime/create-runtime.ts";
import { createAuthorizationMiddleware, isMastraStudioRequest, resolveRequestUser } from "../platform/auth/authorization-middleware.ts";
import { InMemoryAuditLog, PostgresAuditLog } from "../platform/auth/audit-log.ts";
import { InMemoryPermissionStore, PermissionService, PostgresPermissionStore } from "../platform/auth/permission-store.ts";
import { OAuthPrincipalSchema, createServicePrincipal, mapOAuthPrincipal } from "../platform/auth/oauth-principal.ts";
import { devRuntimeTunnelServerEnabled, resolveRedisDurabilityEnabled, verifyWebhookToken } from "../../packages/adapters/src/index.ts";
import { createScopedWorkspace } from "../platform/workspace/create-workspace.ts";
import { createAdminUiApplication } from "../platform/admin-ui/application.ts";
import { flattenApplicationRegistry } from "../runtime/registry-validator.ts";
import { LifecycleContainer } from "../platform/storage/lifecycle.ts";
import { sanitizeTelemetry } from "../platform/observability/sanitize.ts";
import { GoogleOidcService, type PlatformGoogleUser } from "../platform/auth/google-oidc.ts";
import { MASTRA_API_PREFIX, MASTRA_STUDIO_BASE } from "../runtime/mastra-paths.ts";
import { closeDevelopmentConnections } from "../platform/http/development-connections.ts";
import { applyStudioNetworkPolicy } from "../platform/http/studio-network-policy.ts";
import { seedServiceRolePermissions } from "../platform/auth/service-role-permissions.ts";
import { runtimeReadiness } from "../platform/storage/readiness.ts";
import { resolveDevelopmentPrincipal } from "../platform/auth/development-principal.ts";
import { GLOBAL_SKILLS_PATH } from "./skill-paths.ts";
import { startDevRuntimeTunnelClient } from "./applications/qasey/dev-runtime-client.ts";
import {
  QASEY_LOCAL_SLASH_COMMAND_SETUP,
  registerQaseySlackTunnelCommand,
} from "./applications/qasey/slack-tunnel-command.ts";
import {
  InMemorySlackInstallationRepository,
  PostgresSlackInstallationRepository,
} from "../platform/channels/slack-installation-repository.ts";
import { SlackIntegrationManager } from "../platform/channels/slack-integration-manager.ts";
import { ManagedSlackProvider } from "./managed-slack-provider.ts";
import { TriggerProviderRegistry } from "../platform/triggers/trigger-provider-registry.ts";
import { SlackTriggerProvider } from "../platform/triggers/slack-trigger-provider.ts";

const googleOidc = new GoogleOidcService({
  ...(config.GOOGLE_CLIENT_ID ? { clientId: config.GOOGLE_CLIENT_ID } : {}),
  ...(config.GOOGLE_CLIENT_SECRET ? { clientSecret: config.GOOGLE_CLIENT_SECRET } : {}),
  callbackUrl: config.GOOGLE_REDIRECT_URI ?? `${config.QASEY_PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/google/callback`,
  ...(config.GOOGLE_COOKIE_PASSWORD ? { cookiePassword: config.GOOGLE_COOKIE_PASSWORD } : {}),
  ...(config.GOOGLE_ALLOWED_DOMAINS ? { allowedDomains: config.GOOGLE_ALLOWED_DOMAINS } : {}),
  ...(config.GOOGLE_HOSTED_DOMAIN ? { hostedDomain: config.GOOGLE_HOSTED_DOMAIN } : {}),
  secureCookies: config.NODE_ENV === "production",
});

function isGoogleUser(user: unknown): user is PlatformGoogleUser {
  return typeof user === "object" && user !== null
    && "googleId" in user && typeof user.googleId === "string";
}

const formatDatadogSpan: CustomSpanFormatter = span => {
  const requestContext = span.requestContext ? {
    applicationId: span.requestContext.applicationId,
    requestId: span.requestContext.requestId,
    tenantId: span.requestContext.tenantId,
    userId: span.requestContext.userId,
    channel: span.requestContext.channel,
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
      service: config.DD_SERVICE,
      env: config.DD_ENV ?? config.NODE_ENV,
      agentless: false,
      requestContextKeys: ["applicationId", "requestId", "tenantId", "userId", "mastra__threadId", "taskId", "channel"],
      customSpanFormatter: formatDatadogSpan,
    })
  : undefined;

const permissionStore = config.NODE_ENV === "production" && config.DATABASE_URL
  ? new PostgresPermissionStore(config.DATABASE_URL)
  : new InMemoryPermissionStore();
const permissionService = new PermissionService(permissionStore);
const auditLog = config.NODE_ENV === "production" && config.DATABASE_URL
  ? new PostgresAuditLog(config.DATABASE_URL)
  : new InMemoryAuditLog();
const slackCredentialKey = config.MASTRA_ENCRYPTION_KEY
  ?? config.GOOGLE_COOKIE_PASSWORD
  ?? "qasey-local-managed-slack-credentials";
const slackInstallationRepository = config.NODE_ENV === "production" && config.DATABASE_URL
  ? new PostgresSlackInstallationRepository(config.DATABASE_URL, slackCredentialKey)
  : new InMemorySlackInstallationRepository(slackCredentialKey);
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
runtimeReadiness.register("audit-log", () => auditLog.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("slack-installations", () => slackInstallationRepository.healthCheck?.() ?? Promise.resolve());
await Promise.all([
  initializeQaseyInfrastructure(),
  permissionStore.init?.(),
  auditLog.init?.(),
  slackInstallationRepository.init?.(),
]);
await seedServiceRolePermissions(permissionService, config.JIRA_BASE_URL);
runtimeReadiness.markInitializationComplete();
const bootstrapAdmins = new Set((process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS ?? "")
  .split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
const qaseyApplication = createQaseyApplication({
  taskWorkflowModule,
  e2eModule,
  scorerModule,
  caseWorkflowModule,
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
  triggerProviders,
});
const lifecycle = new LifecycleContainer();
lifecycle.own({ close: closeQaseyInfrastructure });
if (permissionStore.close) lifecycle.own({ close: () => permissionStore.close!() });
if (auditLog.close) lifecycle.own({ close: () => auditLog.close!() });
if (slackInstallationRepository.close) lifecycle.own({ close: () => slackInstallationRepository.close!() });
lifecycle.own(managedSlackProvider);
const remoteSandboxPool = sandboxPoolClient;
const workspace = lifecycle.own(createScopedWorkspace({
  root: config.QASEY_WORKSPACE_DIR,
  production: config.NODE_ENV === "production",
  enableCodeExecution: config.QASEY_ENABLE_LOCAL_CODE_MODE || config.QASEY_SANDBOX_ENABLED,
  skills: [GLOBAL_SKILLS_PATH],
  ...(remoteSandboxPool ? {
    remoteFilesystem: scope => remoteSandboxPool.filesystem(scope),
    remoteSandbox: scope => remoteSandboxPool.sandbox(scope),
  } : {}),
}));
const redisKeyPrefix = `qasey:${process.env.NAMESPACE?.trim() || config.NODE_ENV}`;
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
if (cacheClient) lifecycle.own({ close: async () => { await cacheClient.quit(); } });
const cache = cacheClient
  ? new RedisServerCache({ client: cacheClient }, { keyPrefix: `${redisKeyPrefix}:cache` })
  : undefined;

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
    ...(studioEditorEnabled ? { editor: new MastraEditor({ source: "db" }) } : {}),
    environment: config.NODE_ENV,
    workspace,
  },
  server,
  middlewareFactory: catalog => {
    const authorization = createAuthorizationMiddleware({
      catalog,
      permissions: permissionService,
      audit: auditLog,
      // Studio is available in every environment; OAuth, RBAC, and audit remain
      // the security boundary. High-risk Editor/MCP features stay separately gated.
      studioUiEnabled: true,
      resolvePrincipal: async (requestContext, request) => {
        const user = await resolveRequestUser(requestContext, request, isGoogleUser, googleOidc);
        if (user) {
          const tenantId = user.hostedDomain ?? user.email?.split("@")[1];
          if (!tenantId) return undefined;
          const roles = ["user"];
          if (user.email && bootstrapAdmins.has(user.email.toLowerCase())) roles.push("platform-admin");
          if (permissionStore instanceof InMemoryPermissionStore) {
            permissionStore.grant(
              tenantId,
              "user",
              "platform.admin-ui.access",
              "qasey.agent.execute",
              "qasey.e2e.execute",
              "qasey.runs.read",
              "qasey.runs.write",
              "qasey.runs.approve",
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
        const ingressToken = request.header("authorization")?.replace(/^Bearer\s+/iu, "")
          ?? request.header("x-qasey-webhook-token");
        const jiraIngress = request.path.includes("jira");
        const workerIngress = !jiraIngress && verifyWebhookToken(ingressToken, config.WORKER_TOKEN);
        const platformIngress = !jiraIngress && verifyWebhookToken(ingressToken, config.PLATFORM_SERVICE_TOKEN);
        if (jiraIngress ? !verifyWebhookToken(ingressToken, config.JIRA_WEBHOOK_TOKEN) : !workerIngress && !platformIngress) {
          return undefined;
        }
        const tenantId = jiraIngress && config.JIRA_BASE_URL
          ? new URL(config.JIRA_BASE_URL).hostname
          : "trusted-ingress";
        const role = jiraIngress ? "qasey-ingress" : workerIngress ? "orchestration-worker" : "platform-service";
        const service = createServicePrincipal({ subjectId: role, tenantId, roles: [role] });
        return jiraIngress ? OAuthPrincipalSchema.parse({ ...service, audience: "channel" }) : service;
      },
    });
    return config.NODE_ENV === "development"
      ? [closeDevelopmentConnections, authorization, applyStudioNetworkPolicy]
      : [authorization, applyStudioNetworkPolicy];
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
