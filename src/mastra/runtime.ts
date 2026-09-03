import "../load-env.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from "@mastra/core/storage";
import { createCodeMode, createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import type { CodeModeTransport, ToolObserve } from "@mastra/core/tools";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { ObservabilityStoragePostgresVNext, PostgresStore } from "@mastra/pg";
import { z } from "zod";
import { AgentProgressInputSchema, CreateCaseHubChangeSetSchema, QaseyRequestContextSchema } from "../../packages/contracts/src/index.ts";
import type { E2ERun, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { AgentProgressSession, freezeE2EContext } from "../../packages/domain/src/index.ts";
import type { ToolsInput } from "@mastra/core/agent";
import {
  InMemoryCaseHubRepository, InMemoryRunRepository, PrismaCaseHubRepository, PrismaRunRepository,
} from "../../packages/domain/src/index.ts";
import { assertOpenAICompatibleToolSchemas, createGitHubClient, GitHubPublisher, loadConfig, QaseyMcpCatalog, JiraClient, ReadConnectorCatalog, resolveCredentialKeyring } from "../../packages/adapters/src/index.ts";
import {
  E2ECoordinator, LocalArtifactStore, NoopDraftPrBroker, S3ArtifactStore,
} from "../../packages/e2e/src/index.ts";
import { ownerScopeFromRequestContext } from "../platform/context/owner-scope.ts";
import { createCompositeStore } from "../platform/storage/create-composite-store.ts";
import { InMemoryChannelDeliveryInbox, PrismaChannelDeliveryInbox } from "../platform/channels/delivery-inbox.ts";
import { runtimeReadiness } from "../platform/storage/readiness.ts";
import { InMemorySandboxLeaseStore, PrismaSandboxLeaseStore } from "../platform/workspace/sandbox-lease-store.ts";
import { SandboxPoolClient } from "../platform/workspace/sandbox-client.ts";
import { PooledSandboxCodeTaskRunnerProvider } from "../platform/code-task/pooled-sandbox-runner.ts";
import { webE2EConfigurationFromSkill } from "../platform/code-task/e2e-repository-skill.ts";
import { resolveBuildMetadata } from "../platform/e2e/build-metadata.ts";
import { E2EFixtureLeaseService } from "../platform/e2e/fixture-service.ts";
import { E2EPreflightService } from "../platform/e2e/preflight.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../platform/context/schema.ts";
import { applyDevRuntimeApprovalGate } from "./applications/qasey/dev-runtime-approval-gate.ts";
import { createApplicationDatabase } from "../platform/storage/prisma.ts";
import { InMemoryExternalConnectionStore, PrismaExternalConnectionStore } from "../platform/connections/connection-store.ts";
import { ConnectionBackedReadConnectorResolver } from "../platform/connections/read-connector-resolver.ts";
import { TenantGitHubConnectionResolver } from "../platform/connections/github-connection-resolver.ts";
import { InMemoryFailureInboxStore, PrismaFailureInboxStore } from "../platform/recovery/failure-inbox.ts";
import { InMemoryEffectReceiptStore, PrismaEffectReceiptStore, SideEffectExecutor } from "../platform/recovery/effect-receipts.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const resolveProjectPath = (value: string) => isAbsolute(value) ? value : resolve(projectRoot, value);
const loadedConfig = loadConfig();
export const config = {
  ...loadedConfig,
  QASEY_MCP_CONFIG_FILE: resolveProjectPath(loadedConfig.QASEY_MCP_CONFIG_FILE),
  QASEY_MCP_OAUTH_DIR: resolveProjectPath(loadedConfig.QASEY_MCP_OAUTH_DIR),
  QASEY_OBSERVABILITY_DB_PATH: resolveProjectPath(loadedConfig.QASEY_OBSERVABILITY_DB_PATH),
  QASEY_ARTIFACT_DIR: resolveProjectPath(loadedConfig.QASEY_ARTIFACT_DIR),
  QASEY_WORKSPACE_DIR: resolveProjectPath(loadedConfig.QASEY_WORKSPACE_DIR),
  QASEY_GIT_CACHE_DIR: resolveProjectPath(loadedConfig.QASEY_GIT_CACHE_DIR),
  QASEY_DATA_ROOT: resolveProjectPath(loadedConfig.QASEY_DATA_ROOT),
};
export const studioMcpPreviewEnabled = config.QASEY_ENABLE_STUDIO_MCP_PREVIEW
  ?? false;
export const QASEY_REQUEST_CONTEXT_REQUIRED_MESSAGE = "Qasey request context has not been initialized";
export const applicationDatabase = config.DATABASE_URL ? createApplicationDatabase(config.DATABASE_URL) : undefined;
export const buildMetadata = resolveBuildMetadata(projectRoot);

/**
 * Compose Mastra application state and telemetry domains explicitly.
 */
const runtimeStore = createCompositeStore({
  environment: config.NODE_ENV,
  projectRoot,
  ...(config.DATABASE_URL ? { databaseUrl: config.DATABASE_URL } : {}),
  ...(config.OBSERVABILITY_DATABASE_URL ? { observabilityDatabaseUrl: config.OBSERVABILITY_DATABASE_URL } : {}),
  observabilityDbPath: config.QASEY_OBSERVABILITY_DB_PATH,
});
export const mastraStorage = runtimeStore.primary;
export function createMastraRuntimeStorage(): MastraCompositeStore { return runtimeStore.storage; }
export const runRepository = applicationDatabase ? new PrismaRunRepository(applicationDatabase.client) : new InMemoryRunRepository();
export const caseHubRepository = applicationDatabase
  ? new PrismaCaseHubRepository(applicationDatabase.client)
  : new InMemoryCaseHubRepository();
export const failureInboxStore = applicationDatabase
  ? new PrismaFailureInboxStore(applicationDatabase.client)
  : new InMemoryFailureInboxStore();
export const effectReceiptStore = applicationDatabase
  ? new PrismaEffectReceiptStore(applicationDatabase.client)
  : new InMemoryEffectReceiptStore();
export const sideEffectExecutor = new SideEffectExecutor(effectReceiptStore);
export const channelDeliveryInbox = config.DATABASE_URL
  ? new PrismaChannelDeliveryInbox(applicationDatabase!.client)
  : new InMemoryChannelDeliveryInbox();
export const credentialKeyring = resolveCredentialKeyring(
  config,
  config.NODE_ENV === "production" ? undefined : randomBytes(32).toString("base64url"),
);
export const externalConnectionStore = config.NODE_ENV === "production" && applicationDatabase
  ? new PrismaExternalConnectionStore(applicationDatabase.client, credentialKeyring)
  : new InMemoryExternalConnectionStore(credentialKeyring);
export const tenantGitHubConnections = new TenantGitHubConnectionResolver(externalConnectionStore);
const githubTokenForScope = config.QASEY_TENANCY_MODE === "multi"
  ? (scope: { tenantId: string }) => tenantGitHubConnections.token(scope.tenantId)
  : config.GITHUB_TOKEN
    ? async () => config.GITHUB_TOKEN!
    : undefined;
const sandboxEndpointTemplate = config.QASEY_SANDBOX_ENDPOINT_TEMPLATE;
const sandboxLeaseOptions = config.QASEY_SANDBOX_LEASE_KEY
  ? {
      replicas: config.QASEY_SANDBOX_REPLICAS,
      maxSessionsPerReplica: config.QASEY_SANDBOX_MAX_SESSIONS,
      idleTtlMs: config.QASEY_SANDBOX_IDLE_TTL_MS,
      encryptionKey: config.QASEY_SANDBOX_LEASE_KEY,
    }
  : undefined;
export const sandboxLeaseStore = sandboxEndpointTemplate
  ? config.DATABASE_URL && sandboxLeaseOptions
    ? new PrismaSandboxLeaseStore(applicationDatabase!.client, sandboxLeaseOptions)
    : new InMemorySandboxLeaseStore(sandboxLeaseOptions!)
  : undefined;
export const sandboxPoolClient = sandboxLeaseStore
  ? new SandboxPoolClient(sandboxLeaseStore, {
      endpointTemplate: sandboxEndpointTemplate!,
      controlKey: config.QASEY_SANDBOX_CONTROL_KEY!,
      replicas: config.QASEY_SANDBOX_REPLICAS,
      requestTimeoutMs: config.QASEY_SANDBOX_REQUEST_TIMEOUT_MS,
      ...(githubTokenForScope ? { githubTokenForScope } : {}),
    })
  : undefined;
export const codeTaskRunnerProvider = sandboxPoolClient
  ? new PooledSandboxCodeTaskRunnerProvider(sandboxPoolClient)
  : undefined;
// The registry can survive a development hot reload. Reset it before replacing
// checks so readiness never reports the previous runtime while this one starts.
runtimeReadiness.markInitializationStarted();
runtimeReadiness.register("mastra-storage", async () => {
  if (mastraStorage) await mastraStorage.db.one("SELECT 1");
});
if (applicationDatabase) runtimeReadiness.register("application-database", () => applicationDatabase.healthCheck());
runtimeReadiness.register("run-repository", () => runRepository.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("case-hub-repository", () => caseHubRepository.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("failure-inbox", () => failureInboxStore.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("effect-receipts", () => effectReceiptStore.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("channel-delivery-inbox", () => channelDeliveryInbox.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("external-connections", () => externalConnectionStore.healthCheck?.() ?? Promise.resolve());
if (sandboxLeaseStore) runtimeReadiness.register("sandbox-lease-store", () => sandboxLeaseStore.healthCheck());
if (sandboxPoolClient) runtimeReadiness.register("sandbox-pool", () => sandboxPoolClient.healthCheck());
export const mcpCatalog = new QaseyMcpCatalog(config, {
  ...(applicationDatabase ? { database: applicationDatabase.client } : {}),
  connectionStore: externalConnectionStore,
});
runtimeReadiness.register("mcp-oauth-storage", () => mcpCatalog.healthCheck());
export const githubClient = createGitHubClient(config);
export const readConnectorCatalog = new ReadConnectorCatalog(
  config,
  new ConnectionBackedReadConnectorResolver(externalConnectionStore),
);
export const jiraClient = new JiraClient(config.JIRA_BASE_URL, config.JIRA_EMAIL, config.JIRA_API_TOKEN);
export const artifactStore = config.QASEY_ARTIFACT_STORE === "s3"
  ? new S3ArtifactStore({
      bucket: config.QASEY_ARTIFACT_S3_BUCKET!,
      region: config.QASEY_ARTIFACT_S3_REGION!,
      prefix: config.QASEY_ARTIFACT_S3_PREFIX,
      retentionDays: config.QASEY_ARTIFACT_RETENTION_DAYS,
      ...(config.QASEY_ARTIFACT_S3_ENDPOINT ? { endpoint: config.QASEY_ARTIFACT_S3_ENDPOINT } : {}),
      ...(config.QASEY_ARTIFACT_S3_FORCE_PATH_STYLE !== undefined
        ? { forcePathStyle: config.QASEY_ARTIFACT_S3_FORCE_PATH_STYLE }
        : {}),
      ...(config.QASEY_ARTIFACT_S3_KMS_KEY_ID ? { kmsKeyId: config.QASEY_ARTIFACT_S3_KMS_KEY_ID } : {}),
    })
  : new LocalArtifactStore(config.QASEY_ARTIFACT_DIR);
runtimeReadiness.register("artifact-store", () => artifactStore.healthCheck());
export const githubPublisher = new GitHubPublisher(githubClient);
const draftPrBroker = githubPublisher.configured || config.QASEY_TENANCY_MODE === "multi"
  ? {
      publishChanges: async (run: E2ERun, changes: Array<{ path: string; deleted: boolean; mode?: "100644" | "100755" | "120000"; content?: Buffer }>, reviewUrl: string) => {
        const publisher = config.QASEY_TENANCY_MODE === "multi"
          ? await tenantGitHubConnections.publisher(run.tenantId, run.repository.owner)
          : githubPublisher;
        return publisher.publishChanges({
          repository: run.repository,
          baseSha: run.baseSha!,
          branch: run.branch ?? `qasey/${run.id}`,
          title: `test(e2e): Qasey run ${run.id}`,
          body: [`## Qasey generated E2E`, ``, `Change Set: ${run.changeSetId}`, `Review and evidence: ${reviewUrl}`, ``, `Clean verifier completed. Per-case review is still required.`].join("\n"),
          changes,
          ...(run.pullRequestUrl ? { existingPullRequestUrl: run.pullRequestUrl } : {}),
        });
      },
      markReady: async (run: E2ERun) => {
        if (!run.pullRequestUrl) return;
        const publisher = config.QASEY_TENANCY_MODE === "multi"
          ? await tenantGitHubConnections.publisher(run.tenantId, run.repository.owner)
          : githubPublisher;
        await publisher.markPullRequestReady(run.pullRequestUrl);
      },
    }
  : new NoopDraftPrBroker();
export const e2eFixtureLeaseService = new E2EFixtureLeaseService(
  buildMetadata,
  applicationDatabase?.client,
);
export const e2ePreflight = new E2EPreflightService({
  buildMetadata,
  environment: process.env,
  ...(sandboxPoolClient ? { sandbox: sandboxPoolClient } : {}),
  ...(githubClient ? { github: githubClient } : {}),
});
const e2eAuthenticationSecrets = {
  resolve: async ({ names }: { names: readonly string[] }) => Object.fromEntries(names.map(name => {
    const value = process.env[name];
    if (!value?.trim()) throw new Error(`E2E authentication environment is missing ${name}`);
    return [name, value];
  })),
};
export const e2eCoordinator = new E2ECoordinator(
  runRepository,
  artifactStore,
  draftPrBroker,
  {
    maxRepairs: config.QASEY_MAX_REPAIRS,
    reviewBaseUrl: config.QASEY_PUBLIC_BASE_URL,
    effects: sideEffectExecutor,
    ...(codeTaskRunnerProvider ? { codeTasks: codeTaskRunnerProvider } : {}),
    authenticationSecrets: e2eAuthenticationSecrets,
  },
);

let infrastructureInitialization: Promise<void> | undefined;

/** Complete storage migrations before the HTTP server can accept traffic. */
export function initializeQaseyInfrastructure(): Promise<void> {
  infrastructureInitialization ??= Promise.all([
    runtimeStore.storage.init(),
    applicationDatabase?.init(),
    runRepository.init?.(),
    caseHubRepository.init?.(),
    failureInboxStore.init?.(),
    effectReceiptStore.init?.(),
    channelDeliveryInbox.init?.(),
    sandboxLeaseStore?.init(),
    externalConnectionStore.init?.(),
    mcpCatalog.init(),
  ]).then(() => undefined);
  return infrastructureInitialization;
}

export async function closeQaseyInfrastructure(): Promise<void> {
  const resources: Array<{ close(): Promise<void> }> = [
    mcpCatalog, externalConnectionStore, effectReceiptStore, failureInboxStore, artifactStore, channelDeliveryInbox, caseHubRepository, runRepository, runtimeStore.storage,
    ...(sandboxLeaseStore ? [sandboxLeaseStore] : []),
    ...(applicationDatabase ? [applicationDatabase] : []),
  ];
  const results = await Promise.allSettled(resources.map(resource => resource.close()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, "Qasey infrastructure shutdown failed");
}

export interface QaseyRequestContextMap {
  "qasey-context": QaseyRequestContext;
  "agent-progress-session"?: AgentProgressSession;
  "qasey-agent-run-id"?: string;
  "qasey-execution-events"?: unknown;
  native?: boolean;
}

export interface QaseyAgentTooling {
  /** Tools visible directly to the model. Read tools move behind Code Mode. */
  tools: ToolsInput;
  /** Generated declarations for the exact read-tool allow-list in `tools`. */
  codeModeInstructions?: string;
  codeModeToolNames: string[];
}

const qaseyToolingByRequest = new WeakMap<object, Promise<QaseyAgentTooling>>();
/** Code Mode is retained for future evaluation but intentionally not exposed to qasey-main. */
export const qaseyCodeModeActive = false;
const quickJsCodeModeTransport = new QuickJsCodeModeTransport({
  memoryLimitMb: config.QASEY_CODE_MODE_MEMORY_LIMIT_MB,
});
const codeModeObservationContext = new AsyncLocalStorage<ToolObserve>();

const observableQuickJsCodeModeTransport: CodeModeTransport = {
  requiresSandbox: quickJsCodeModeTransport.requiresSandbox,
  run: options => quickJsCodeModeTransport.run({
    ...options,
    dispatch: async (toolId, input) => {
      const observe = codeModeObservationContext.getStore();
      if (!observe) return options.dispatch(toolId, input);
      let failureResult: unknown;
      let caughtStructuredFailure = false;
      try {
        return await observe.span(
          `code-mode external tool: '${toolId}'`,
          async () => {
            const result = await options.dispatch(toolId, input);
            const failure = codeModeExternalFailure(result);
            if (failure) {
              caughtStructuredFailure = true;
              failureResult = result;
              throw failure;
            }
            return result;
          },
          { toolId, codeModeExternal: true },
        );
      } catch (error) {
        if (!caughtStructuredFailure) throw error;
        observe.log("error", "code-mode external tool returned a structured failure", {
          toolId,
          error: error instanceof Error ? error.message : String(error),
        });
        return failureResult;
      }
    },
  }),
};

function codeModeExternalFailure(result: unknown): Error | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  const failed = record.status === "failed" || record.status === "error"
    || record.success === false || record.ok === false || record.isError === true;
  if (!failed) return undefined;
  const nestedError = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  const message = typeof record.message === "string"
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : typeof nestedError?.message === "string"
        ? nestedError.message
        : typeof record.content === "string"
          ? record.content
          : "Code Mode external tool returned a structured failure";
  const error = new Error(message);
  error.name = "CodeModeExternalToolFailure";
  return error;
}

const studioPreviewRuntime: QaseyRequestContextMap = {
  "qasey-context": {
    requestId: "mastra-studio-preview",
    channel: "api",
    sessionId: "mastra-studio",
    chatInput: "Mastra Studio preview",
    actor: { id: "mastra-studio-user", displayName: "Mastra Studio" },
    source: {},
    attachments: [],
  },
};

export function getRuntimeContext(
  requestContext?: RequestContext<any>,
  options: { allowStudioPreview?: boolean; allowNativeContext?: boolean } = {},
): QaseyRequestContextMap {
  const context = QaseyRequestContextSchema.safeParse(requestContext?.get("qasey-context"));
  if (!context.success && options.allowNativeContext) {
    const identity = requestContext?.get("identity");
    const userId = identity && typeof identity === "object" && "userId" in identity
      ? String((identity as { userId: unknown }).userId) : "";
    const requestId = String(requestContext?.get("requestId") ?? "");
    const sessionId = String(requestContext?.get("sessionId") ?? "");
    if (userId && requestId && sessionId) return {
      "qasey-context": {
        requestId,
        channel: nativeChannel(requestContext?.get("channel")),
        sessionId,
        chatInput: "Native Mastra Agent request",
        actor: { id: userId },
        source: {},
        attachments: [],
      },
      native: true,
    };
  }
  if (!context.success && options.allowStudioPreview) return studioPreviewRuntime;
  if (!context.success) throw new Error(QASEY_REQUEST_CONTEXT_REQUIRED_MESSAGE);
  return { "qasey-context": context.data };
}

const getCurrentTime = createTool({
  id: "get_current_time",
  description: "返回当前 ISO 时间戳和 Asia/Shanghai 本地时间。",
  inputSchema: z.object({}),
  outputSchema: z.object({ iso: z.string(), asiaShanghai: z.string() }),
  execute: async () => ({
    iso: new Date().toISOString(),
    asiaShanghai: new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "long" }).format(new Date()),
  }),
});

export function createAgentProgressTool(progressSession: AgentProgressSession) {
  return createTool({
    id: "qasey_report_progress",
    description: "通过 Qasey 的可靠渠道投递与当前任务相关的发现、决策、风险或阻塞。不要播报通用工作流阶段、工具调用，或仅仅宣布分析开始。选择稳定的 milestone key。这不是完成确认工具：不得声称外部写入、验证、发布或合并成功；这些事实会由运行时在取得可信工具证据后报告。",
    inputSchema: AgentProgressInputSchema,
    outputSchema: z.object({
      accepted: z.boolean(),
      milestone: z.string(),
      sequence: z.number().int().positive().optional(),
      reason: z.enum(["duplicate", "limit_reached", "reserved_milestone", "unverified_completion_claim"]).optional(),
    }),
    execute: async input => progressSession.report(input),
  });
}

function e2eTools() {
  return {
    caseHubSearchCases: createTool({
      id: "case_hub_search_cases",
      description: "在 Qasey Case Hub 中搜索现有测试用例。只读；用于在提交 Change Set 前判断新增或更新。",
      inputSchema: z.object({ query: z.string().max(500).default("") }),
      execute: async ({ query }, { requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        return { cases: await caseHubRepository.listCases(ownerScopeFromRequestContext(requestContext), query) };
      },
    }),
    caseHubCreateChangeSet: createTool({
      id: "case_hub_create_change_set",
      description: "冻结当前需求并提交不可变 Case Change Plan；随后在隔离 sandbox 中生成和验证 Web Playwright。存在 blocking question 时拒绝启动。",
      inputSchema: CreateCaseHubChangeSetSchema,
      execute: async (input, { mastra, requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        const owner = ownerScopeFromRequestContext(requestContext);
        if (input.requirement.blockingQuestions.length > 0) throw new Error("Resolve blocking questions before creating a Case Hub change set");
        const requestId = String(requestContext.get("requestId"));
        const sessionId = String(requestContext.get("sessionId"));
        const resourceId = String(requestContext.get(MASTRA_RESOURCE_ID_KEY));
        const threadId = String(requestContext.get(MASTRA_THREAD_ID_KEY) ?? sessionId);
        const taskRunId = String(requestContext.get("taskId") ?? requestContext.get("executionId") ?? requestId);
        const webE2EConfiguration = webE2EConfigurationFromSkill();
        const preflight = await e2ePreflight.assertReady(owner, webE2EConfiguration);
        const actorId = getRuntimeContext(requestContext)["qasey-context"].actor.id;
        const requirement = freezeE2EContext(input.requirement, { sessionId, threadId, taskRunId, requestId, resourceId });
        const changeSet = await caseHubRepository.createChangeSet(owner, {
          requirement,
          proposals: input.proposals,
          repository: webE2EConfiguration.target,
          createdBy: actorId,
          baseSha: preflight.baseSha,
          environmentSourceSha: buildMetadata.sourceSha,
        });
        const created = await e2eCoordinator.create(owner, {
          changeSetId: changeSet.id,
          handoff: input.requirement,
          platform: "web",
          framework: "playwright",
          requestId,
          sourceSessionId: sessionId,
          repository: webE2EConfiguration.target,
          testEnvironment: webE2EConfiguration.environment,
          playwrightVerification: webE2EConfiguration.verification,
        }, { sessionId, threadId, taskRunId, requestId, resourceId });
        if (!mastra) throw new Error("Mastra runtime is required to start the E2E workflow");
        const run = await mastra.getWorkflow("qasey-e2e-lifecycle").createRun({ runId: created.id, resourceId: actorId });
        try {
          await run.startAsync({ inputData: { runId: created.id }, requestContext });
        } catch (error) {
          await e2eCoordinator.fail(owner, created.id, error);
          throw error;
        }
        return { changeSet, run: created };
      },
    }),
    caseHubGetChangeSet: createTool({
      id: "case_hub_get_change_set",
      description: "读取 Change Set、候选 Case Version 与逐 Case Result。只读。",
      inputSchema: z.object({ changeSetId: z.string().uuid() }),
      execute: async ({ changeSetId }, { requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        const owner = ownerScopeFromRequestContext(requestContext);
        return {
          changeSet: await caseHubRepository.getChangeSet(owner, changeSetId),
          versions: await caseHubRepository.versionsForChangeSet(owner, changeSetId),
          results: await caseHubRepository.listResults(owner, changeSetId),
        };
      },
    }),
    e2eGetRun: createTool({
      id: "e2e_get_run", description: "获取 E2E 运行状态和证据引用。只读。",
      inputSchema: z.object({ runId: z.string().min(1) }),
      execute: async ({ runId }, { requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        const owner = ownerScopeFromRequestContext(requestContext);
        return { run: await runRepository.get(owner, runId), events: await runRepository.events(owner, runId) };
      },
    }),
    caseHubRerunResults: createTool({
      id: "case_hub_rerun_results", description: "基于已有 Change Set 的运行创建新 Run 与 Result Attempt，不修改旧证据。",
      inputSchema: z.object({ runId: z.string().min(1) }),
      execute: async ({ runId }, { mastra, requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        const owner = ownerScopeFromRequestContext(requestContext);
        const previous = await runRepository.get(owner, runId);
        if (!previous) throw new Error(`Run ${runId} not found`);
        const changeSet = await caseHubRepository.getChangeSet(owner, previous.changeSetId);
        if (!changeSet) throw new Error(`Case Hub change set ${previous.changeSetId} not found`);
        if (changeSet.status === "blocked_product" || changeSet.status === "blocked_environment") {
          await caseHubRepository.updateChangeSet(owner, changeSet.id, changeSet.revision, { status: "verifying" });
        } else if (changeSet.status !== "verifying") {
          throw new Error(`Case Hub result rerun requires a blocked Change Set, received ${changeSet.status}`);
        }
        const created = await e2eCoordinator.rerun(owner, runId);
        if (!mastra) throw new Error("Mastra runtime is required to start the E2E workflow");
        const resourceId = getRuntimeContext(requestContext)["qasey-context"].actor.id;
        const workflowRun = await mastra.getWorkflow("qasey-e2e-lifecycle").createRun({ runId: created.id, resourceId });
        await workflowRun.startAsync({ inputData: { runId: created.id }, requestContext });
        return created;
      },
    }),
  };
}

export async function toolsForRequest(requestContext?: RequestContext<any>) {
  const contextProvided = QaseyRequestContextSchema.safeParse(
    requestContext?.get("qasey-context"),
  ).success;
  const studioRequest = requestContext?.get("ingressSource") === "mastra-studio";
  const runtimeContext = getRuntimeContext(requestContext, {
    allowNativeContext: true,
    allowStudioPreview: studioRequest && studioMcpPreviewEnabled,
  });
  const { "qasey-context": context } = runtimeContext;
  // Agent detail/chat requests from Studio do not carry Qasey's ingress
  // context. Flag-enabled Studio previews may discover MCP tools, but they are
  // deliberately read-only so write-capable MCP tools remain filtered out.
  if (!contextProvided) {
    const subject = mcpSubject(requestContext);
    const discoverExternal = studioRequest
      ? studioMcpPreviewEnabled
      : runtimeContext.native;
    const external = discoverExternal
      ? await mcpCatalog.toolsForDiscovery(context.channel, subject, {
          readOnly: true,
        })
      : {};
    const readTools = await readConnectorCatalog.toolsForTenant(subject?.tenantId);
    return { getCurrentTime, ...readTools, ...external };
  }
  const subject = mcpSubject(requestContext);
  const external = await mcpCatalog.toolsForDiscovery(
    context.channel,
    subject,
    { readOnly: false },
  );
  const readTools = await readConnectorCatalog.toolsForTenant(subject?.tenantId);
  const executionTools = e2eTools();
  const progressSession = requestContext?.get("agent-progress-session") instanceof AgentProgressSession
    ? requestContext.get("agent-progress-session") as AgentProgressSession
    : undefined;
  const progressTool = progressSession?.enabled ? {
    qasey_report_progress: createAgentProgressTool(progressSession),
  } : {};
  // Raw case mutations never enter the Agent catalog. The trusted commit Tool
  // invokes the required MCP primitive inside the deterministic Workflow.
  return applyDevRuntimeApprovalGate(
    { getCurrentTime, ...progressTool, ...readTools, ...external, ...executionTools },
    requestContext,
  );
}

/**
 * Resolve one request-scoped tool bundle so the Agent receives a Code Mode tool
 * and the matching generated declarations from the same allow-list. Only
 * explicitly read-only capabilities are composable; side effects stay visible
 * as ordinary tools so their workflow/approval boundaries remain first-class.
 */
export function resolveQaseyAgentTooling(requestContext?: RequestContext<any>): Promise<QaseyAgentTooling> {
  if (!requestContext) return buildQaseyAgentTooling(toolsForRequest(requestContext));
  const cached = qaseyToolingByRequest.get(requestContext);
  if (cached) return cached;
  const pending = buildQaseyAgentTooling(toolsForRequest(requestContext));
  qaseyToolingByRequest.set(requestContext, pending);
  pending.catch(() => qaseyToolingByRequest.delete(requestContext));
  return pending;
}

export async function buildQaseyAgentTooling(
  toolInput: ToolsInput | Promise<ToolsInput>,
  options: { codeModeActive?: boolean } = {},
): Promise<QaseyAgentTooling> {
  const allTools = await toolInput;
  assertOpenAICompatibleToolSchemas(allTools);
  const codeModeActive = options.codeModeActive ?? (qaseyCodeModeActive && config.QASEY_ENABLE_CODE_MODE);
  if (!codeModeActive) {
    return { tools: allTools, codeModeToolNames: [] };
  }
  const { codeModeTools, directTools } = partitionQaseyCodeModeTools(allTools);
  const codeModeToolNames = Object.keys(codeModeTools).sort();
  if (codeModeToolNames.length === 0) {
    return { tools: directTools, codeModeToolNames };
  }
  const codeMode = createCodeMode({
    id: "execute_typescript",
    tools: codeModeTools,
    timeout: config.QASEY_CODE_MODE_TIMEOUT_MS,
  }, observableQuickJsCodeModeTransport);
  const executeCodeMode = codeMode.tool.execute?.bind(codeMode.tool);
  if (executeCodeMode) {
    codeMode.tool.execute = (input, context) => context?.observe
      ? codeModeObservationContext.run(context.observe, () => executeCodeMode(input, context))
      : executeCodeMode(input, context);
  }
  return {
    tools: { ...directTools, execute_typescript: codeMode.tool },
    codeModeInstructions: `${codeMode.instructions}\n\nQasey 专属规则：\n- Code Mode 只包含只读工具。会产生副作用的工具、审批、进度报告和持久化 Workflow 仍作为独立的直接工具提供。\n- 当多个读取操作可以并行、分页、过滤、去重、连接或聚合时，使用 Code Mode。返回精简结果，同时保留作为证据所需的来源标识。`,
    codeModeToolNames,
  };
}

export function partitionQaseyCodeModeTools(tools: ToolsInput): {
  codeModeTools: ToolsInput;
  directTools: ToolsInput;
} {
  const entries = Object.entries(tools);
  return {
    codeModeTools: Object.fromEntries(entries.filter(([toolName]) => isQaseyCodeModeReadTool(toolName))),
    directTools: Object.fromEntries(entries.filter(([toolName]) => !isQaseyCodeModeReadTool(toolName))),
  };
}

function isQaseyCodeModeReadTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "getcurrenttime"
    || normalized === "e2egetrun"
    || normalized === "casehubsearchcases"
    || normalized === "casehubgetchangeset"
    || /^(?:slack_(?:search|get)|github_(?:get|list|search)|jira_(?:get|search))/.test(normalized)
    || /^figma_(?:get|list|export)/.test(normalized)
    || /^qaexperience_(?:qa_context_get|qa_experience_(?:list|read))/.test(normalized)
    || normalized === "rag_answer"
    || /^lark_doc_(?:search|read)/.test(normalized);
}

function nativeChannel(value: unknown): QaseyRequestContext["channel"] {
  if (value === "slack" || value === "jira" || value === "api") return value;
  if (value && typeof value === "object" && "platform" in value) {
    const platform = (value as { platform?: unknown }).platform;
    if (platform === "slack" || platform === "jira") return platform;
  }
  return "api";
}

export function mcpSubject(requestContext?: RequestContext<any>) {
  const applicationId = requestContext?.get("applicationId");
  const identity = requestContext?.get("identity");
  if (typeof applicationId !== "string" || !identity || typeof identity !== "object") return undefined;
  const tenantId = "tenantId" in identity ? (identity as { tenantId?: unknown }).tenantId : undefined;
  const subjectId = "userId" in identity ? (identity as { userId?: unknown }).userId : undefined;
  if (typeof tenantId !== "string" || typeof subjectId !== "string") return undefined;
  return { applicationId, tenantId, subjectId };
}
