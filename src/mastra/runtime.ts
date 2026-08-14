import "dotenv/config";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBStore } from "@mastra/duckdb";
import { FilesystemStore, MastraCompositeStore } from "@mastra/core/storage";
import { createTool, createCodeMode } from "@mastra/core/tools";
import { LocalSandbox } from "@mastra/core/workspace";
import type { RequestContext } from "@mastra/core/request-context";
import { ObservabilityStoragePostgresVNext, PostgresStore } from "@mastra/pg";
import { z } from "zod";
import { CreateE2ERunSchema, IntentRouteSchema, QaseyRequestContextSchema } from "../../packages/contracts/src/index.ts";
import type { E2ERun, IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { EvidenceLedger } from "../../packages/domain/src/index.ts";
import type { ToolsInput } from "@mastra/core/agent";
import {
  InMemoryEventInbox, InMemoryNotificationOutbox, InMemoryRunRepository, InMemoryTriggerQueue,
  PostgresEventInbox, PostgresNotificationOutbox, PostgresRunRepository, PostgresTriggerQueue,
} from "../../packages/domain/src/index.ts";
import { GitHubPublisher, loadConfig, QaseyMcpCatalog, JiraClient, ReadConnectorCatalog, SlackLifecycleClient } from "../../packages/adapters/src/index.ts";
import {
  AcpCodingHarness, CuaFallback, E2ECoordinator, LocalArtifactStore, LocalWorkspaceManager,
  MaestroRunner, NoopCodingHarness, NoopDraftPrBroker, PlaywrightRunner,
} from "../../packages/e2e/src/index.ts";
import type { WorkspaceRef } from "../../packages/e2e/src/index.ts";

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
export const mastraStorage = config.DATABASE_URL
  ? new PostgresStore({
      id: "qasey-primary-storage",
      connectionString: config.DATABASE_URL,
    })
  : undefined;
export const studioEditorEnabled = config.QASEY_ENABLE_STUDIO_EDITOR
  ?? config.NODE_ENV === "development";
export const studioMcpPreviewEnabled = config.QASEY_ENABLE_STUDIO_MCP_PREVIEW
  ?? config.NODE_ENV === "development";

/**
 * Compose Mastra domains explicitly: application state, editor definitions,
 * and telemetry have different scaling and lifecycle requirements.
 */
export function createMastraRuntimeStorage(): MastraCompositeStore {
  const production = config.NODE_ENV === "production";
  if (production && !config.OBSERVABILITY_DATABASE_URL) {
    throw new Error(
      "OBSERVABILITY_DATABASE_URL is required in production and must point to a dedicated Postgres database",
    );
  }
  if (production && studioEditorEnabled && !config.EDITOR_DATABASE_URL) {
    throw new Error(
      "EDITOR_DATABASE_URL is required when the Mastra Editor is enabled in production",
    );
  }

  const editorStorage = studioEditorEnabled
    ? config.EDITOR_DATABASE_URL
      ? new PostgresStore({
          id: "qasey-editor-storage",
          connectionString: config.EDITOR_DATABASE_URL,
        })
      : new FilesystemStore({ dir: resolve(projectRoot, ".qasey/mastra-editor") })
    : undefined;
  const observabilityStorage = config.OBSERVABILITY_DATABASE_URL
    ? new ObservabilityStoragePostgresVNext({
        connectionString: config.OBSERVABILITY_DATABASE_URL,
      })
    : new DuckDBStore({
        id: "qasey-observability-duckdb",
        path: config.QASEY_OBSERVABILITY_DB_PATH,
        memoryLimit: "512MB",
        threads: 2,
      }).observability;

  return new MastraCompositeStore({
    id: "qasey-runtime-storage",
    ...(mastraStorage ? { default: mastraStorage } : {}),
    ...(editorStorage ? { editor: editorStorage } : {}),
    domains: { observability: observabilityStorage },
  });
}
export const runRepository = config.DATABASE_URL ? new PostgresRunRepository(config.DATABASE_URL) : new InMemoryRunRepository();
export const eventInbox = config.DATABASE_URL ? new PostgresEventInbox(config.DATABASE_URL) : new InMemoryEventInbox();
export const triggerQueue = config.DATABASE_URL
  ? new PostgresTriggerQueue(config.DATABASE_URL, config.QASEY_JOB_LEASE_MS)
  : new InMemoryTriggerQueue();
export const notificationOutbox = config.DATABASE_URL ? new PostgresNotificationOutbox(config.DATABASE_URL) : new InMemoryNotificationOutbox();
export const mcpCatalog = new QaseyMcpCatalog(config);
export const readConnectorCatalog = new ReadConnectorCatalog(config);
export const jiraClient = new JiraClient(config.JIRA_BASE_URL, config.JIRA_EMAIL, config.JIRA_API_TOKEN);
export const slackLifecycle = new SlackLifecycleClient(config.SLACK_BOT_TOKEN);
export const workspaceManager = new LocalWorkspaceManager(config.QASEY_WORKSPACE_DIR);
export const codingHarness = config.QASEY_ENABLE_EXECUTION
  ? new AcpCodingHarness(config.QASEY_ACP_COMMAND, config.QASEY_ACP_ARGS)
  : new NoopCodingHarness();
export const artifactStore = new LocalArtifactStore(config.QASEY_ARTIFACT_DIR);
export const githubPublisher = new GitHubPublisher(config.GITHUB_TOKEN);
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

export interface QaseyRequestContextMap {
  "qasey-context": QaseyRequestContext;
  "intent-route": IntentRoute;
  "evidence-ledger"?: EvidenceLedger;
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
  requestContext?: RequestContext,
  options: { allowStudioPreview?: boolean } = {},
): QaseyRequestContextMap {
  const context = QaseyRequestContextSchema.safeParse(requestContext?.get("qasey-context"));
  const route = IntentRouteSchema.safeParse(requestContext?.get("intent-route"));
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

function e2eTools(route: IntentRoute) {
  if (route.intent === "e2e_generate") return {
    e2eCreateRun: createTool({
      id: "e2e_create_run",
      description: "Queue an isolated Playwright (web) or Maestro (app) code-generation and verification run.",
      inputSchema: CreateE2ERunSchema.omit({ requestId: true }),
      execute: async (input, { mastra, requestContext }) => {
        const created = await e2eCoordinator.create(input);
        if (config.QASEY_ENABLE_EXECUTION) {
          if (!mastra) throw new Error("Mastra runtime is required to start the E2E workflow");
          const resourceId = getRuntimeContext(requestContext)["qasey-context"].actor.id;
          const run = await mastra.getWorkflow("e2eLifecycleWorkflow").createRun({ runId: created.id, resourceId });
          await run.startAsync({ inputData: { runId: created.id } });
        }
        return created;
      },
    }),
  };
  if (route.intent === "e2e_status") return {
    e2eGetRun: createTool({
      id: "e2e_get_run", description: "Get E2E run status and evidence references. Read-only.",
      inputSchema: z.object({ runId: z.string().min(1) }),
      execute: async ({ runId }) => ({ run: await runRepository.get(runId), events: await runRepository.events(runId) }),
    }),
  };
  if (route.intent === "e2e_rerun") return {
    e2eRerun: createTool({
      id: "e2e_rerun", description: "Create a new execution from an existing E2E run without modifying the old evidence.",
      inputSchema: z.object({ runId: z.string().min(1) }),
      execute: async ({ runId }, { mastra, requestContext }) => {
        const created = await e2eCoordinator.rerun(runId);
        if (config.QASEY_ENABLE_EXECUTION) {
          if (!mastra) throw new Error("Mastra runtime is required to start the E2E workflow");
          const resourceId = getRuntimeContext(requestContext)["qasey-context"].actor.id;
          const workflowRun = await mastra.getWorkflow("e2eLifecycleWorkflow").createRun({ runId: created.id, resourceId });
          await workflowRun.startAsync({ inputData: { runId: created.id } });
        }
        return created;
      },
    }),
  };
  return {};
}

export async function toolsForRequest(requestContext?: RequestContext) {
  const contextProvided = QaseyRequestContextSchema.safeParse(
    requestContext?.get("qasey-context"),
  ).success && IntentRouteSchema.safeParse(requestContext?.get("intent-route")).success;
  const { "qasey-context": context, "intent-route": route } = getRuntimeContext(requestContext, {
    allowStudioPreview: config.NODE_ENV === "development",
  });
  // Agent detail/chat requests from Studio do not carry Qasey's ingress
  // context. Development Studio may discover MCP tools, but the fallback route
  // is deliberately read-only so write-capable MCP tools remain filtered out.
  if (!contextProvided) {
    const external = config.NODE_ENV === "development" && studioMcpPreviewEnabled
      ? await mcpCatalog.toolsFor(route, context.channel)
      : {};
    return { getCurrentTime, ...readConnectorCatalog.tools(), ...external };
  }
  const effectiveRoute = config.QASEY_SHADOW_MODE && route.writeTarget !== "none"
    ? { ...route, intent: "qa_review" as const, writeTarget: "none" as const }
    : route;
  const external = await mcpCatalog.toolsFor(effectiveRoute, context.channel);
  const readTools = readConnectorCatalog.tools();
  const executionTools = config.QASEY_SHADOW_MODE ? {} : e2eTools(route);
  const ledger = requestContext?.get("evidence-ledger") instanceof EvidenceLedger
    ? requestContext.get("evidence-ledger") as EvidenceLedger
    : undefined;
  const guardedExternal = guardToolsWithEvidence(external, ledger);
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
  if (config.QASEY_ENABLE_LOCAL_CODE_MODE && Object.keys(external).length > 0) {
    // Approval must remain visible to Mastra. Do not hide approval-gated tools
    // behind the single Code Mode executor, which would bypass tool suspension.
    const requiresApproval = (tool: unknown) => Boolean(
      tool && typeof tool === "object" && "requireApproval" in tool
      && (tool as { requireApproval?: unknown }).requireApproval === true,
    );
    const approvalTools = Object.fromEntries(Object.entries(guardedExternal).filter(([, tool]) => requiresApproval(tool)));
    const codeModeExternal = Object.fromEntries(Object.entries(guardedExternal).filter(([, tool]) => !requiresApproval(tool)));
    const { tool } = createCodeMode({ tools: { ...guardedReadTools, ...codeModeExternal, ...guardedExecutionTools, ...evidenceReader }, sandbox: new LocalSandbox({ workingDirectory: process.cwd() }), timeout: 150_000 });
    const guardedCodeMode = guardToolsWithEvidence({ executeTypescript: tool }, ledger);
    return { ...guardedUtilityTools, ...guardedCodeMode, ...evidenceReader, ...approvalTools };
  }
  return { ...guardedUtilityTools, ...guardedReadTools, ...guardedExternal, ...guardedExecutionTools, ...evidenceReader };
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
        () => execute(input, executionContext),
      ),
    }];
  }));
}
