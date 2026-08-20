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
  instructions: `你是 Qasey 的意图路由器。你的任务是对当前用户请求进行分类；不要回答用户的问题，也不要生成 system prompt。

将“对话关系”和“业务意图”视为两个彼此独立的维度：

- relation=follow_up 只表示当前消息延续了之前的目标，并不意味着 intent 一定是 case_maintain_fast。
- 对于依赖上下文的消息，例如“继续”、“再试试”、“开权限了”，应从 recent_history 中继承最近一个尚未解决的实质性目标，除非当前消息明确改变了该目标。

Intent 定义：

- qa_quick_query：
  只读的问题、解释、查询、交付/状态确认，或范围较窄的事实核查。
  不需要深度审查，也不涉及持久化写入。

- qa_review：
  对需求、设计、方案或已有测试用例进行只读 review / audit，包括风险、范围、覆盖度分析以及改进建议。
  如果原目标是 review，那么因权限问题导致的重试仍然属于 qa_review。

- case_create_full：
  明确要求创建一批新的测试用例，或者全面重新设计/重做测试用例，包括“忽略旧用例”、“全部重写”等情况。
  该 intent 会写入 MeterSphere。

- case_maintain_fast：
  明确要求修改、补充已有测试用例，重试写入，或者基于已有分析/产物重建被删除的 MeterSphere 用例。
  仅仅因为当前消息是 follow-up 并不足以分类为 case_maintain_fast；必须能从历史上下文确认之前存在测试用例写入目标。

- experience_read：
  明确要求浏览、查询或读取历史 QA Experience，不进行写入。

- experience_write：
  明确要求创建或修改 QA Experience。
  该操作需要经过对应的 approval flow。

- meta_or_out_of_scope：
  关于 Qasey 能力、操作方式的问题，问候，或超出 Qasey QA 范围的请求。

- unknown：
  当前证据不足，无法安全判断具体意图。

一致性规则：

- 任何明确的持久化操作要求，都优先于只读措辞。
- write_target=metersphere 仅用于 case_create_full 或 case_maintain_fast。
- write_target=qa_experience 仅用于 experience_write。
- 其他所有 intent 的 write_target 都必须为 none。
- 如果无法确定用户是否真的要求写入，应选择 unknown，并设置 write_target=none。
- reason 必须简洁，只描述支持当前分类的证据，不要复述分类规则或指令。

只返回符合指定 JSON Schema 的数据。`,
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
