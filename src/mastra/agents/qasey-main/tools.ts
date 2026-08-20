import type { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
import { resolveQaseyAgentTooling } from "../../runtime.ts";
import { startQaseyCorrelatedSpan } from "../../applications/qasey/observability.ts";

/**
 * Resolve the request-scoped tool allow-list for qasey-main.
 *
 * This deliberately remains a dynamic Agent config function: Qasey's tools
 * depend on intent, channel, identity, shadow mode, and the evidence ledger.
 * They must not be converted into statically discovered file-based tools.
 */
export async function resolveQaseyMainTools({
  requestContext,
  mastra,
}: {
  requestContext: RequestContext<any>;
  mastra?: Mastra;
}) {
  const route = requestContext.get("intent-route") as { intent?: unknown; depth?: unknown } | undefined;
  const span = startQaseyCorrelatedSpan(mastra, requestContext, "qasey tools resolve", {
    intent: route?.intent,
    depth: route?.depth,
  });
  try {
    const tooling = await resolveQaseyAgentTooling(requestContext);
    const tools = tooling.tools;
    span?.end({
      metadata: {
        intent: route?.intent,
        depth: route?.depth,
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools).sort(),
        codeModeToolNames: tooling.codeModeToolNames,
      },
    });
    return tools;
  } catch (error) {
    span?.error({
      error: error instanceof Error ? error : new Error(String(error)),
      endSpan: true,
    });
    throw error;
  }
}
