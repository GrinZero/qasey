import type { RequestContext } from "@mastra/core/request-context";
import {
  BatchPartsProcessor,
  TokenLimiter,
  ToolCallFilter,
  ToolSearchProcessor,
} from "@mastra/core/processors";
import type { Processor, ProcessInputStepArgs, ProcessInputStepResult } from "@mastra/core/processors";
import { QASEY_REQUIRED_METERSPHERE_TOOL_NAMES } from "../../../../packages/adapters/src/index.ts";
import {
  config,
  getRuntimeContext,
  QASEY_REQUEST_CONTEXT_REQUIRED_MESSAGE,
  studioMcpPreviewEnabled,
  toolsForRequest,
} from "../../runtime.ts";

/** Time is the primary run limit; this only protects against an unexpectedly hot loop. */
export const QASEY_AGENT_SAFETY_MAX_STEPS = 10_000;
export const QASEY_AGENT_FINAL_RESPONSE_GRACE_MS = 5 * 60_000;

const QASEY_RUN_STARTED_AT_STATE_KEY = "qasey-run-started-at";
const QASEY_DIRECT_TOOL_NAMES = new Set<string>(QASEY_REQUIRED_METERSPHERE_TOOL_NAMES);

/** Reserve time for a final answer before the wall-clock abort signal fires. */
export class EnsureQaseyDeadlineResponseProcessor implements Processor {
  readonly id = "qasey-ensure-final-response";

  constructor(
    private readonly timeoutMs = config.QASEY_AGENT_TIMEOUT_MS,
    private readonly finalResponseGraceMs = QASEY_AGENT_FINAL_RESPONSE_GRACE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async processInputStep({ state, sendSignal }: ProcessInputStepArgs): Promise<ProcessInputStepResult> {
    const currentTime = this.now();
    const storedStartedAt = state[QASEY_RUN_STARTED_AT_STATE_KEY];
    const startedAt = typeof storedStartedAt === "number" ? storedStartedAt : currentTime;
    state[QASEY_RUN_STARTED_AT_STATE_KEY] = startedAt;
    const remainingMs = this.timeoutMs - (currentTime - startedAt);
    if (remainingMs > this.finalResponseGraceMs) return {};
    await sendSignal?.({
      type: "reactive",
      contents: "运行即将达到时间上限。不要再调用工具；请基于已经取得的结果给出完整最终回答，并明确尚未完成的事项。",
      attributes: {
        reason: "deadline-approaching",
        deadlineMs: this.timeoutMs,
        remainingMs: Math.max(0, remainingMs),
      },
    });
    return { toolChoice: "none" };
  }
}

class QaseyDirectToolsProcessor implements Processor {
  readonly id = "qasey-direct-tools";

  constructor(private readonly directTools: Record<string, unknown>) {}

  async processInputStep({ tools }: ProcessInputStepArgs): Promise<ProcessInputStepResult> {
    return { tools: { ...tools, ...this.directTools } };
  }
}

/**
 * Mastra resolves dynamic processors with an empty context while serializing
 * Agent metadata. Keep that path side-effect free, but preserve strict context
 * validation when the resulting processor workflow actually executes.
 */
class RequireQaseyRequestContextProcessor implements Processor {
  readonly id = "qasey-require-request-context";

  processInputStep({ requestContext }: ProcessInputStepArgs): ProcessInputStepResult {
    const studioRequest = requestContext?.get("ingressSource") === "mastra-studio";
    getRuntimeContext(requestContext, {
      allowNativeContext: true,
      allowStudioPreview: studioRequest && studioMcpPreviewEnabled,
    });
    return {};
  }
}

export function partitionQaseyDirectTools<T extends Record<string, unknown>>(tools: T): {
  directTools: T;
  searchableTools: T;
} {
  const entries = Object.entries(tools);
  return {
    directTools: Object.fromEntries(entries.filter(([toolName]) => QASEY_DIRECT_TOOL_NAMES.has(toolName))) as T,
    searchableTools: Object.fromEntries(entries.filter(([toolName]) => !QASEY_DIRECT_TOOL_NAMES.has(toolName))) as T,
  };
}

export function createQaseyContextProcessors(modelOutputToolNames: string[] = []) {
  return [
    new ToolCallFilter({
      // Filter only tools that explicitly provide a safe model projection.
      // Framework control tools such as skill/search_tools must retain their
      // invocation/result pair. Do not filter during the active loop: the
      // current turn keeps its complete causal chain, while a later request
      // compacts older external reads as they are loaded from memory.
      exclude: modelOutputToolNames,
      preserveModelOutput: true,
    }),
    new EnsureQaseyDeadlineResponseProcessor(),
    new TokenLimiter({ limit: config.QASEY_MEMORY_INPUT_TOKEN_LIMIT }),
  ];
}

/** Coalesce model deltas before durable stream events are synchronized through Redis. */
export function createQaseyStreamBatcher() {
  return new BatchPartsProcessor({
    batchSize: 10,
    maxWaitTime: 30,
    emitOnNonText: true,
  });
}

/**
 * Resolve the caller-bound capability catalog once per request. Stable
 * MeterSphere case-management tools are injected directly; optional tools stay
 * out of the prompt until qasey-main discovers them. Agent-level Skill tools
 * remain framework-managed and are not hidden here.
 */
export async function resolveQaseyMainInputProcessors({
  requestContext,
}: {
  requestContext: RequestContext<any>;
}) {
  let tools: Awaited<ReturnType<typeof toolsForRequest>>;
  try {
    tools = await toolsForRequest(requestContext);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== QASEY_REQUEST_CONTEXT_REQUIRED_MESSAGE) throw error;
    // `Agent.getConfiguredProcessorWorkflows()` deliberately supplies a fresh,
    // empty RequestContext. It needs the stable processor topology, not tools.
    tools = {} as Awaited<ReturnType<typeof toolsForRequest>>;
  }
  const { directTools, searchableTools } = partitionQaseyDirectTools(tools);
  const modelOutputToolNames = Object.entries(tools)
    .filter(([, tool]) => {
      return Boolean(tool && typeof tool === "object" && "toModelOutput" in tool && typeof tool.toModelOutput === "function");
    })
    .map(([toolName]) => toolName);
  return [
    new RequireQaseyRequestContextProcessor(),
    new ToolSearchProcessor({
      tools: searchableTools,
      storage: "context",
      search: {
        topK: 8,
        autoLoad: true,
      },
    }),
    new QaseyDirectToolsProcessor(directTools),
    ...createQaseyContextProcessors(modelOutputToolNames),
  ];
}
