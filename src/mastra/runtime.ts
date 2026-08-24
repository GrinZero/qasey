import "../load-env.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBStore } from "@mastra/duckdb";
import { FilesystemStore, MastraCompositeStore } from "@mastra/core/storage";
import { createCodeMode, createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import type { CodeModeTransport, ToolObserve } from "@mastra/core/tools";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { ObservabilityStoragePostgresVNext, PostgresStore } from "@mastra/pg";
import { z } from "zod";
import { AgentProgressInputSchema, CreateE2ERunSchema, QaseyRequestContextSchema } from "../../packages/contracts/src/index.ts";
import type { E2ERun, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { AgentProgressSession } from "../../packages/domain/src/index.ts";
import type { ToolsInput } from "@mastra/core/agent";
import {
  InMemoryRunRepository, PostgresRunRepository,
} from "../../packages/domain/src/index.ts";
import { assertOpenAICompatibleToolSchemas, createGitHubClient, GitHubInstallationTokenProvider, GitHubPublisher, loadConfig, QaseyMcpCatalog, JiraClient, ReadConnectorCatalog } from "../../packages/adapters/src/index.ts";
import {
  AcpCodingHarness, CuaFallback, E2ECoordinator, LocalArtifactStore, LocalWorkspaceManager,
  MaestroRunner, NoopCodingHarness, NoopDraftPrBroker, PlaywrightRunner,
} from "../../packages/e2e/src/index.ts";
import type { WorkspaceRef } from "../../packages/e2e/src/index.ts";
import { ownerScopeFromRequestContext } from "../platform/context/owner-scope.ts";
import { createCompositeStore } from "../platform/storage/create-composite-store.ts";
import { InMemoryChannelDeliveryInbox, PostgresChannelDeliveryInbox } from "../platform/channels/delivery-inbox.ts";
import { runtimeReadiness } from "../platform/storage/readiness.ts";
import { InMemorySandboxLeaseStore, PostgresSandboxLeaseStore } from "../platform/workspace/sandbox-lease-store.ts";
import { SandboxPoolClient } from "../platform/workspace/sandbox-client.ts";

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
export const studioEditorEnabled = config.QASEY_ENABLE_STUDIO_EDITOR
  ?? config.NODE_ENV === "development";
export const studioMcpPreviewEnabled = config.QASEY_ENABLE_STUDIO_MCP_PREVIEW
  ?? false;
export const QASEY_REQUEST_CONTEXT_REQUIRED_MESSAGE = "Qasey request context has not been initialized";

/**
 * Compose Mastra domains explicitly: application state, editor definitions,
 * and telemetry have different scaling and lifecycle requirements.
 */
const runtimeStore = createCompositeStore({
  environment: config.NODE_ENV,
  projectRoot,
  ...(config.DATABASE_URL ? { databaseUrl: config.DATABASE_URL } : {}),
  ...(config.OBSERVABILITY_DATABASE_URL ? { observabilityDatabaseUrl: config.OBSERVABILITY_DATABASE_URL } : {}),
  ...(config.EDITOR_DATABASE_URL ? { editorDatabaseUrl: config.EDITOR_DATABASE_URL } : {}),
  observabilityDbPath: config.QASEY_OBSERVABILITY_DB_PATH,
  editorEnabled: studioEditorEnabled,
});
export const mastraStorage = runtimeStore.primary;
export function createMastraRuntimeStorage(): MastraCompositeStore { return runtimeStore.storage; }
export const runRepository = config.DATABASE_URL ? new PostgresRunRepository(config.DATABASE_URL) : new InMemoryRunRepository();
export const channelDeliveryInbox = config.DATABASE_URL
  ? new PostgresChannelDeliveryInbox(config.DATABASE_URL)
  : new InMemoryChannelDeliveryInbox();
export const githubReadTokens = config.GITHUB_APP_ID && config.GITHUB_APP_INSTALLATION_ID && config.GITHUB_APP_PRIVATE_KEY
  ? new GitHubInstallationTokenProvider(config)
  : undefined;
const sandboxLeaseOptions = {
  replicas: config.QASEY_SANDBOX_REPLICAS,
  maxSessionsPerReplica: config.QASEY_SANDBOX_MAX_SESSIONS,
  idleTtlMs: config.QASEY_SANDBOX_IDLE_TTL_MS,
  encryptionKey: config.GOOGLE_COOKIE_PASSWORD ?? config.MASTRA_ENCRYPTION_KEY ?? "qasey-local-sandbox-lease-key",
};
export const sandboxLeaseStore = config.QASEY_SANDBOX_ENABLED
  ? config.DATABASE_URL
    ? new PostgresSandboxLeaseStore(config.DATABASE_URL, sandboxLeaseOptions)
    : new InMemorySandboxLeaseStore(sandboxLeaseOptions)
  : undefined;
export const sandboxPoolClient = sandboxLeaseStore
  ? new SandboxPoolClient(sandboxLeaseStore, {
      endpointTemplate: config.QASEY_SANDBOX_ENDPOINT_TEMPLATE,
      requestTimeoutMs: config.QASEY_SANDBOX_REQUEST_TIMEOUT_MS,
      ...(githubReadTokens ? { githubTokenForScope: () => githubReadTokens.readToken() } : {}),
    })
  : undefined;
// The registry can survive a development hot reload. Reset it before replacing
// checks so readiness never reports the previous runtime while this one starts.
runtimeReadiness.markInitializationStarted();
runtimeReadiness.register("mastra-storage", async () => {
  if (mastraStorage) await mastraStorage.db.one("SELECT 1");
});
runtimeReadiness.register("run-repository", () => runRepository.healthCheck?.() ?? Promise.resolve());
runtimeReadiness.register("channel-delivery-inbox", () => channelDeliveryInbox.healthCheck?.() ?? Promise.resolve());
if (sandboxLeaseStore) runtimeReadiness.register("sandbox-lease-store", () => sandboxLeaseStore.healthCheck());
export const mcpCatalog = new QaseyMcpCatalog(config);
runtimeReadiness.register("mcp-oauth-storage", () => mcpCatalog.healthCheck());
runtimeReadiness.register("metersphere-mcp-tools", () => mcpCatalog.healthCheckRequiredMeterSphereTools());
export const githubClient = createGitHubClient(config);
export const readConnectorCatalog = new ReadConnectorCatalog(config);
export const jiraClient = new JiraClient(config.JIRA_BASE_URL, config.JIRA_EMAIL, config.JIRA_API_TOKEN);
export const workspaceManager = new LocalWorkspaceManager(config.QASEY_WORKSPACE_DIR, config.QASEY_GIT_CACHE_DIR);
export const codingHarness = config.QASEY_ENABLE_EXECUTION
  ? new AcpCodingHarness(config.QASEY_ACP_COMMAND, config.QASEY_ACP_ARGS)
  : new NoopCodingHarness();
export const artifactStore = new LocalArtifactStore(config.QASEY_ARTIFACT_DIR);
export const githubPublisher = new GitHubPublisher(githubClient);
const draftPrBroker = !config.QASEY_SHADOW_MODE && config.QASEY_ENABLE_DRAFT_PR && githubPublisher.configured
  ? {
      publish: (run: E2ERun, workspace: WorkspaceRef, reviewUrl: string) => githubPublisher.publishWorkspace({
        repository: run.repository,
        root: workspace.root,
        branch: workspace.branch,
        title: `test(e2e): Qasey run ${run.id}`,
        body: [`## Qasey generated E2E`, ``, `Cases: ${run.sourceCaseIds.join(", ")}`, `Review and evidence: ${reviewUrl}`, ``, `Clean verifier passed. QA approval is still required.`].join("\n"),
      }),
      markReady: (run: E2ERun) => run.pullRequestUrl ? githubPublisher.markPullRequestReady(run.pullRequestUrl) : Promise.resolve(),
    }
  : new NoopDraftPrBroker();
export const e2eCoordinator = new E2ECoordinator(
  runRepository,
  workspaceManager,
  codingHarness,
  { playwright: new PlaywrightRunner(), maestro: new MaestroRunner() },
  artifactStore,
  draftPrBroker,
  config.QASEY_ENABLE_EXECUTION,
  {
    maxRepairs: config.QASEY_MAX_REPAIRS,
    reviewBaseUrl: config.QASEY_PUBLIC_BASE_URL,
    ...(config.QASEY_ENABLE_CUA_FALLBACK ? { cua: new CuaFallback() } : {}),
  },
);

let infrastructureInitialization: Promise<void> | undefined;

/** Complete storage migrations before the HTTP server can accept traffic. */
export function initializeQaseyInfrastructure(): Promise<void> {
  infrastructureInitialization ??= Promise.all([
    runtimeStore.storage.init(),
    runRepository.init?.(),
    channelDeliveryInbox.init?.(),
    sandboxLeaseStore?.init(),
    mcpCatalog.init(),
  ]).then(() => undefined);
  return infrastructureInitialization;
}

export async function closeQaseyInfrastructure(): Promise<void> {
  const resources: Array<{ close(): Promise<void> }> = [
    mcpCatalog, channelDeliveryInbox, runRepository, runtimeStore.storage,
    ...(sandboxLeaseStore ? [sandboxLeaseStore] : []),
  ];
  const results = await Promise.allSettled(resources.map(resource => resource.close()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, "Qasey infrastructure shutdown failed");
}

export interface QaseyRequestContextMap {
  "qasey-context": QaseyRequestContext;
  "case-plan"?: import("../../packages/domain/src/index.ts").MeterSphereCasePlan;
  "agent-progress-session"?: AgentProgressSession;
  "case-operation-phase"?: "planning" | "execution";
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
    e2eCreateRun: createTool({
      id: "e2e_create_run",
      description: "创建一个隔离的 Playwright（Web）或 Maestro（App）代码生成与验证运行。",
      inputSchema: CreateE2ERunSchema.omit({ requestId: true }),
      execute: async (input, { mastra, requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        const owner = ownerScopeFromRequestContext(requestContext);
        const created = await e2eCoordinator.create(owner, input);
        if (config.QASEY_ENABLE_EXECUTION) {
          if (!mastra) throw new Error("Mastra runtime is required to start the E2E workflow");
          const resourceId = getRuntimeContext(requestContext)["qasey-context"].actor.id;
          const run = await mastra.getWorkflow("qasey-e2e-lifecycle").createRun({ runId: created.id, resourceId });
          await run.startAsync({ inputData: { runId: created.id }, requestContext });
        }
        return created;
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
    e2eRerun: createTool({
      id: "e2e_rerun", description: "基于已有 E2E 运行创建新的执行，不修改旧证据。",
      inputSchema: z.object({ runId: z.string().min(1) }),
      execute: async ({ runId }, { mastra, requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        const owner = ownerScopeFromRequestContext(requestContext);
        const created = await e2eCoordinator.rerun(owner, runId);
        if (config.QASEY_ENABLE_EXECUTION) {
          if (!mastra) throw new Error("Mastra runtime is required to start the E2E workflow");
          const resourceId = getRuntimeContext(requestContext)["qasey-context"].actor.id;
          const workflowRun = await mastra.getWorkflow("qasey-e2e-lifecycle").createRun({ runId: created.id, resourceId });
          await workflowRun.startAsync({ inputData: { runId: created.id }, requestContext });
        }
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
    return { getCurrentTime, ...readConnectorCatalog.tools(), ...external };
  }
  const external = await mcpCatalog.toolsForDiscovery(
    context.channel,
    mcpSubject(requestContext),
    { readOnly: config.QASEY_SHADOW_MODE },
  );
  const readTools = readConnectorCatalog.tools();
  const executionTools = config.QASEY_SHADOW_MODE ? {} : e2eTools();
  const progressSession = requestContext?.get("agent-progress-session") instanceof AgentProgressSession
    ? requestContext.get("agent-progress-session") as AgentProgressSession
    : undefined;
  const progressTool = progressSession?.enabled ? {
    qasey_report_progress: createAgentProgressTool(progressSession),
  } : {};
  // qasey-main may discover case mutation tools for dry-run planning, but the
  // deterministic MeterSphere workflow is the only owner of real writes.
  const ownershipScopedExternal = guardCaseMutationsForWorkflow(external);
  return { getCurrentTime, ...progressTool, ...readTools, ...ownershipScopedExternal, ...executionTools };
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
    || /^(?:slack_(?:search|get)|github_(?:get|list|search)|jira_(?:get|search))/.test(normalized)
    || /^metersphere_ms_(?:get|list)/.test(normalized)
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

/**
 * During case planning the Agent may validate the proposed bulk payload, but
 * only the deterministic workflow owns the real case mutation.
 */
export function guardCaseMutationsForWorkflow(tools: ToolsInput): ToolsInput {
  return Object.fromEntries(Object.entries(tools).map(([toolName, tool]) => {
    if (!isMeterSphereCaseMutation(toolName)) return [toolName, tool];
    const execute = (tool as { execute?: (input: unknown, context: unknown) => Promise<unknown> }).execute;
    if (!execute) return [toolName, tool];
    return [toolName, {
      ...tool,
      execute: async (input: unknown, executionContext: Parameters<typeof execute>[1]) => {
        if (toolName.toLowerCase().includes("bulk_upsert_test_cases")
          && input && typeof input === "object"
          && (input as { dry_run?: unknown }).dry_run === true) {
          return execute(input, executionContext);
        }
        throw new Error(`Case mutation ${toolName} is owned by the MeterSphere case operation workflow`);
      },
    }];
  }));
}

function isMeterSphereCaseMutation(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized.includes("metersphere")
    && /(?:bulk_upsert_test_cases|create_test_case|edit_test_case|batch_edit_test_cases)/.test(normalized);
}
