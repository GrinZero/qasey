import { Agent } from "@mastra/core/agent";
import type { TracingContext } from "@mastra/core/observability";
import type { RequestContext } from "@mastra/core/request-context";
import type { IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { IntentRouteSchema } from "../../packages/contracts/src/index.ts";
import { fallbackIntentRoute, sanitizeIntentRoute } from "../../packages/domain/src/index.ts";
import { logInfo } from "../../packages/adapters/src/index.ts";
import { intentResponsesModel } from "./models.ts";
import { PlatformRequestContextSchema } from "../platform/context/schema.ts";

export const intentRouterAgent = new Agent({
  id: "qasey-intent-router",
  name: "Qasey Intent Router",
  model: intentResponsesModel,
  requestContextSchema: PlatformRequestContextSchema,
  instructions: `Classify Qasey requests. Never answer the user.
Intent definitions:
- qa_quick_query: a focused QA question that needs an answer but no comprehensive review or persistent write.
- qa_review: comprehensive requirement, risk, scope, or coverage analysis.
- case_create_full: create, design, rebuild, or write a complete test-case set to MeterSphere.
- case_maintain_fast: update, supplement, retry, or repair an existing MeterSphere case set.
- experience_read / experience_write: read or explicitly persist reusable QA experience.
- e2e_generate / e2e_rerun / e2e_repair / e2e_status: generate, rerun, repair, or inspect E2E automation.
- meta_or_out_of_scope: capability/help requests or requests outside Qasey's scope.
- unknown: genuinely ambiguous requests, especially ambiguous writes.
Relation and business intent are separate. Explicit persistent action dominates read-only wording.
For context-dependent follow-ups, inherit only an unresolved substantive goal from recent history.
If uncertain about a write, use unknown and writeTarget none. Return only structured data.`,
});

export async function routeIntent(
  context: QaseyRequestContext,
  recentHistory: string[] = [],
  abortSignal?: AbortSignal,
  agent: Agent<any, any, any, any, any> = intentRouterAgent,
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
      ...(abortSignal ? { abortSignal } : {}),
      ...(observability.requestContext ? { requestContext: observability.requestContext } : {}),
      ...(observability.tracingContext ? { tracingContext: observability.tracingContext } : {}),
      structuredOutput: {
        schema: IntentRouteSchema,
        errorStrategy: "strict",
        jsonPromptInjection: "auto",
        providerOptions: { openai: { reasoningEffort: "low" } },
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
