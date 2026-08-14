import { Agent } from "@mastra/core/agent";
import type { IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { IntentRouteSchema } from "../../packages/contracts/src/index.ts";
import { classifyIntentDeterministically, sanitizeIntentRoute } from "../../packages/domain/src/index.ts";
import { intentResponsesModel } from "./models.ts";

export const intentRouterAgent = new Agent({
  id: "qasey-intent-router",
  name: "Qasey Intent Router",
  model: intentResponsesModel,
  instructions: `Classify Qasey requests. Never answer the user.
Relation and business intent are separate. Explicit persistent action dominates read-only wording.
For context-dependent follow-ups, inherit only an unresolved substantive goal from recent history.
If uncertain about a write, use unknown and writeTarget none. Return only structured data.`,
});

export async function routeIntent(
  context: QaseyRequestContext,
  recentHistory: string[] = [],
  abortSignal?: AbortSignal,
  agent: Agent = intentRouterAgent,
): Promise<IntentRoute> {
  if (!process.env.OPENAI_API_KEY && !process.env.AI_GATEWAY_API_KEY) {
    return classifyIntentDeterministically(context.chatInput, recentHistory);
  }
  try {
    const result = await agent.generate([
      `channel: ${context.channel}`,
      `session_id: ${context.sessionId}`,
      `recent_history: ${JSON.stringify(recentHistory.slice(-6))}`,
      `current_message:\n${context.chatInput}`,
    ].join("\n"), {
      maxSteps: 1,
      ...(abortSignal ? { abortSignal } : {}),
      structuredOutput: {
        schema: IntentRouteSchema,
        errorStrategy: "strict",
        jsonPromptInjection: "auto",
        providerOptions: { openai: { reasoningEffort: "low" } },
      },
    });
    return sanitizeIntentRoute(result.object);
  } catch (error) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : error;
    }
    return classifyIntentDeterministically(context.chatInput, recentHistory);
  }
}
