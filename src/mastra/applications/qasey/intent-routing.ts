import type { Agent } from "@mastra/core/agent";
import type { TracingContext } from "@mastra/core/observability";
import type { RequestContext } from "@mastra/core/request-context";
import type { IntentRoute, QaseyRequestContext } from "../../../../packages/contracts/src/index.ts";
import { IntentRouteSchema } from "../../../../packages/contracts/src/index.ts";
import { fallbackIntentRoute, sanitizeIntentRoute } from "../../../../packages/domain/src/index.ts";
import { logInfo } from "../../../../packages/adapters/src/index.ts";

export async function routeIntent(
  context: QaseyRequestContext,
  recentHistory: string[],
  abortSignal: AbortSignal | undefined,
  agent: Agent<any, any, any, any, any>,
  observability: { requestContext?: RequestContext<any>; tracingContext?: TracingContext } = {},
): Promise<IntentRoute> {
  const startedAt = Date.now();
  try {
    const result = await agent.generate([
      `channel: ${context.channel}`,
      `session_id: ${context.sessionId}`,
      `recent_history: ${JSON.stringify(recentHistory.slice(-6))}`,
      `current_message:\n${context.chatInput}`,
    ].join("\n"), {
      maxSteps: 1,
      activeTools: [],
      toolChoice: "none",
      ...(abortSignal ? { abortSignal } : {}),
      ...(observability.requestContext ? { requestContext: observability.requestContext } : {}),
      ...(observability.tracingContext ? { tracingContext: observability.tracingContext } : {}),
      structuredOutput: {
        schema: IntentRouteSchema,
        errorStrategy: "strict",
        jsonPromptInjection: "auto",
        providerOptions: { openai: { reasoningEffort: "low", serviceTier: "priority" } },
      },
    });
    const route = sanitizeIntentRoute(result.object);
    logInfo("intent.routing.completed", {
      requestId: context.requestId,
      mode: "model",
      intent: route.intent,
      confidence: route.confidence,
      durationMs: Date.now() - startedAt,
    });
    return route;
  } catch (error) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : error;
    }
    const route = fallbackIntentRoute(error instanceof Error
      ? `Intent model failed: ${error.message}`
      : "Intent model failed");
    logInfo("intent.routing.completed", {
      requestId: context.requestId,
      mode: "model_fallback",
      intent: route.intent,
      confidence: route.confidence,
      durationMs: Date.now() - startedAt,
    });
    return route;
  }
}
