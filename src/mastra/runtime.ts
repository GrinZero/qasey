import "../load-env.ts";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBStore } from "@mastra/duckdb";
import { FilesystemStore, MastraCompositeStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import { ObservabilityStoragePostgresVNext, PostgresStore } from "@mastra/pg";
import { z } from "zod";
import { AgentProgressInputSchema, CreateE2ERunSchema, IntentRouteSchema, QaseyRequestContextSchema } from "../../packages/contracts/src/index.ts";
import type { E2ERun, IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { AgentProgressSession, EvidenceLedger } from "../../packages/domain/src/index.ts";
import type { ToolsInput } from "@mastra/core/agent";
import {
  InMemoryRunRepository, PostgresRunRepository,
} from "../../packages/domain/src/index.ts";
import { createGitHubClient, GitHubPublisher, loadConfig, QaseyMcpCatalog, JiraClient, ReadConnectorCatalog } from "../../packages/adapters/src/index.ts";
import {
  AcpCodingHarness, CuaFallback, E2ECoordinator, LocalArtifactStore, LocalWorkspaceManager,
  MaestroRunner, NoopCodingHarness, NoopDraftPrBroker, PlaywrightRunner,
} from "../../packages/e2e/src/index.ts";
import type { WorkspaceRef } from "../../packages/e2e/src/index.ts";
import { ownerScopeFromRequestContext } from "../platform/context/owner-scope.ts";
import { createCompositeStore } from "../platform/storage/create-composite-store.ts";
import { InMemoryChannelDeliveryInbox, PostgresChannelDeliveryInbox } from "../platform/channels/delivery-inbox.ts";

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
};
export const studioEditorEnabled = config.QASEY_ENABLE_STUDIO_EDITOR
  ?? config.NODE_ENV === "development";
export const studioMcpPreviewEnabled = config.QASEY_ENABLE_STUDIO_MCP_PREVIEW
  ?? false;

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
export const mcpCatalog = new QaseyMcpCatalog(config);
export const githubClient = createGitHubClient(config);
export const readConnectorCatalog = new ReadConnectorCatalog(config, githubClient);
export const jiraClient = new JiraClient(config.JIRA_BASE_URL, config.JIRA_EMAIL, config.JIRA_API_TOKEN);
export const workspaceManager = new LocalWorkspaceManager(config.QASEY_WORKSPACE_DIR);
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

export async function closeQaseyInfrastructure(): Promise<void> {
  const resources: Array<{ close(): Promise<void> }> = [mcpCatalog, channelDeliveryInbox, runRepository, runtimeStore.storage];
  const results = await Promise.allSettled(resources.map(resource => resource.close()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, "Qasey infrastructure shutdown failed");
}

export interface QaseyRequestContextMap {
  "qasey-context": QaseyRequestContext;
  "intent-route": IntentRoute;
  "case-plan"?: import("../../packages/domain/src/index.ts").MeterSphereCasePlan;
  "evidence-ledger"?: EvidenceLedger;
  "agent-progress-session"?: AgentProgressSession;
  "case-operation-phase"?: "planning" | "execution";
  native?: boolean;
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
  "intent-route": {
    version: 2,
    intent: "unknown",
    relation: "new",
    writeTarget: "none",
    depth: "standard",
    confidence: 0,
    reason: "Mastra Studio did not provide Qasey request context; using read-only preview mode.",
    routerStatus: "fallback",
  },
};

export function getRuntimeContext(
  requestContext?: RequestContext<any>,
  options: { allowStudioPreview?: boolean; allowNativeContext?: boolean } = {},
): QaseyRequestContextMap {
  const context = QaseyRequestContextSchema.safeParse(requestContext?.get("qasey-context"));
  const route = IntentRouteSchema.safeParse(requestContext?.get("intent-route"));
  if ((!context.success || !route.success) && options.allowNativeContext) {
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
      "intent-route": studioPreviewRuntime["intent-route"],
      native: true,
    };
  }
  if ((!context.success || !route.success) && options.allowStudioPreview) return studioPreviewRuntime;
  if (!context.success || !route.success) throw new Error("Qasey request context has not been initialized");
  return { "qasey-context": context.data, "intent-route": route.data };
}

const getCurrentTime = createTool({
  id: "get_current_time",
  description: "Return the current ISO timestamp and Asia/Shanghai local time.",
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
    description: "Share a task-specific discovery, decision, risk, or blocker through Qasey's reliable channel delivery. Do not announce generic workflow stages, tool calls, or that analysis merely started. Choose a stable milestone key. This is not a completion tool: never claim that an external write, verification, publication, or merge succeeded; those facts are reported by the runtime after trusted tool evidence.",
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

function e2eTools(route: IntentRoute) {
  if (route.intent === "e2e_generate") return {
    e2eCreateRun: createTool({
      id: "e2e_create_run",
      description: "Queue an isolated Playwright (web) or Maestro (app) code-generation and verification run.",
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
  };
  if (route.intent === "e2e_status") return {
    e2eGetRun: createTool({
      id: "e2e_get_run", description: "Get E2E run status and evidence references. Read-only.",
      inputSchema: z.object({ runId: z.string().min(1) }),
      execute: async ({ runId }, { requestContext }) => {
        if (!requestContext) throw new Error("Trusted request context is required");
        const owner = ownerScopeFromRequestContext(requestContext);
        return { run: await runRepository.get(owner, runId), events: await runRepository.events(owner, runId) };
      },
    }),
  };
  if (route.intent === "e2e_rerun") return {
    e2eRerun: createTool({
      id: "e2e_rerun", description: "Create a new execution from an existing E2E run without modifying the old evidence.",
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
  return {};
}

export async function toolsForRequest(requestContext?: RequestContext<any>) {
  const contextProvided = QaseyRequestContextSchema.safeParse(
    requestContext?.get("qasey-context"),
  ).success && IntentRouteSchema.safeParse(requestContext?.get("intent-route")).success;
  const runtimeContext = getRuntimeContext(requestContext, {
    allowNativeContext: true,
    allowStudioPreview: config.NODE_ENV === "development",
  });
  const { "qasey-context": context, "intent-route": route } = runtimeContext;
  // Agent detail/chat requests from Studio do not carry Qasey's ingress
  // context. Development Studio may discover MCP tools, but the fallback route
  // is deliberately read-only so write-capable MCP tools remain filtered out.
  if (!contextProvided) {
    const subject = mcpSubject(requestContext);
    const studioRequest = requestContext?.get("ingressSource") === "mastra-studio";
    const discoverExternal = studioRequest
      ? config.NODE_ENV === "development" && studioMcpPreviewEnabled
      : runtimeContext.native;
    const external = discoverExternal
      ? await mcpCatalog.toolsFor(route, context.channel, subject)
      : {};
    return { getCurrentTime, ...readConnectorCatalog.tools(), ...external };
  }
  const effectiveRoute = config.QASEY_SHADOW_MODE && route.writeTarget !== "none"
    ? { ...route, intent: "qa_review" as const, writeTarget: "none" as const }
    : route;
  const external = await mcpCatalog.toolsFor(effectiveRoute, context.channel, mcpSubject(requestContext));
  const readTools = readConnectorCatalog.tools();
  const executionTools = config.QASEY_SHADOW_MODE ? {} : e2eTools(route);
  const ledger = requestContext?.get("evidence-ledger") instanceof EvidenceLedger
    ? requestContext.get("evidence-ledger") as EvidenceLedger
    : undefined;
  const progressSession = requestContext?.get("agent-progress-session") instanceof AgentProgressSession
    ? requestContext.get("agent-progress-session") as AgentProgressSession
    : undefined;
  const progressTool = progressSession?.enabled ? {
    qasey_report_progress: createAgentProgressTool(progressSession),
  } : {};
  const phase = requestContext?.get("case-operation-phase");
  const ownershipScopedExternal = phase === "planning"
    ? guardCaseMutationsForWorkflow(external)
    : external;
  const guardedExternal = guardToolsWithEvidence(ownershipScopedExternal, ledger);
  const guardedReadTools = guardToolsWithEvidence(readTools, ledger);
  const guardedExecutionTools = guardToolsWithEvidence(executionTools, ledger);
  const guardedUtilityTools = guardToolsWithEvidence({ getCurrentTime }, ledger);
  const evidenceReader = ledger ? {
    qasey_read_evidence_artifact: createTool({
      id: "qasey_read_evidence_artifact",
      description: "Read a bounded slice of an evidence artifact already acquired in this run. Never re-fetch the original source just to recover compacted details.",
      inputSchema: z.object({
        artifactId: z.string().min(1),
        offset: z.number().int().nonnegative().default(0),
        maxChars: z.number().int().min(1).max(20_000).default(12_000),
      }),
      execute: async ({ artifactId, offset, maxChars }) => ledger.readArtifact(artifactId, offset, maxChars),
    }),
  } : {};
  return { ...guardedUtilityTools, ...progressTool, ...guardedReadTools, ...guardedExternal, ...guardedExecutionTools, ...evidenceReader };
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

export function guardToolsWithEvidence(tools: ToolsInput, ledger?: EvidenceLedger): ToolsInput {
  if (!ledger) return tools;
  return Object.fromEntries(Object.entries(tools).map(([toolName, tool]) => {
    const execute = (tool as { execute?: (input: unknown, context: unknown) => Promise<unknown> }).execute;
    if (!execute) return [toolName, tool];
    return [toolName, {
      ...tool,
      execute: async (input: unknown, executionContext: Parameters<typeof execute>[1]) => ledger.execute(
        toolName,
        input,
        effectiveInput => execute(effectiveInput, executionContext),
      ),
    }];
  }));
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
