import type { RequestContext } from "@mastra/core/request-context";
import { BatchPartsProcessor, TokenLimiter, ToolSearchProcessor } from "@mastra/core/processors";
import { config, toolsForRequest } from "../../runtime.ts";

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
        topK: 3,
        autoLoad: true,
      },
    }),
    new TokenLimiter({ limit: config.QASEY_MEMORY_INPUT_TOKEN_LIMIT }),
  ];
}
