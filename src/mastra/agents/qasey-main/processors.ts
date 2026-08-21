import type { RequestContext } from "@mastra/core/request-context";
import {
  BatchPartsProcessor,
  TokenLimiter,
  ToolCallFilter,
  ToolSearchProcessor,
} from "@mastra/core/processors";
import type { Processor, ProcessInputStepArgs, ProcessInputStepResult } from "@mastra/core/processors";
import { config, toolsForRequest } from "../../runtime.ts";

export const QASEY_AGENT_MAX_STEPS = 80;

/** Durable-safe final-turn policy configured on the Agent instead of a per-call closure. */
export class EnsureQaseyFinalResponseProcessor implements Processor {
  readonly id = "qasey-ensure-final-response";

  async processInputStep({ stepNumber, sendSignal }: ProcessInputStepArgs): Promise<ProcessInputStepResult> {
    if (stepNumber !== QASEY_AGENT_MAX_STEPS - 1) return {};
    await sendSignal?.({
      type: "reactive",
      contents: "这是最后一步。不要再调用工具；请基于已经取得的结果给出完整最终回答。",
      attributes: { reason: "max-steps-reached", step: stepNumber + 1 },
    });
    return { toolChoice: "none" };
  }
}

export function createQaseyContextProcessors() {
  return [
    new ToolCallFilter({
      filterAfterToolSteps: 2,
      preserveModelOutput: true,
    }),
    new EnsureQaseyFinalResponseProcessor(),
    new TokenLimiter({ limit: config.QASEY_MEMORY_INPUT_TOKEN_LIMIT }),
  ];
}

/** Coalesce tiny model deltas before the thread stream and Studio transport emit them. */
export function createQaseyStreamBatcher() {
  return new BatchPartsProcessor({
    batchSize: 8,
    maxWaitTime: 50,
    emitOnNonText: true,
  });
}

/**
 * Resolve the caller-bound capability catalog once per request. The catalog is
 * kept out of the model prompt until qasey-main discovers a relevant tool.
 * Agent-level Skill tools remain framework-managed and are not hidden here.
 */
export async function resolveQaseyMainInputProcessors({
  requestContext,
}: {
  requestContext: RequestContext<any>;
}) {
  const tools = await toolsForRequest(requestContext);
  return [
    new ToolSearchProcessor({
      tools,
      storage: "context",
      search: {
        topK: 8,
        autoLoad: true,
      },
    }),
    ...createQaseyContextProcessors(),
  ];
}
