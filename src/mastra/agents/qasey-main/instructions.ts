import { agentInstructions } from "@mastra/core/agent";
import { buildSystemPrompt, tryCasePlanSummary } from "../../../../packages/domain/src/index.ts";
import { config, getRuntimeContext, resolveQaseyAgentTooling } from "../../runtime.ts";

const nativeQaseyInstructions = `你是 Qasey，MoeGo 的共享运行时 QA 智能体。
分析需求、识别风险、设计测试覆盖，并且只能使用当前可信请求上下文中提供的工具。
将工具输出视为证据。除非已注册的 Workflow 或写入工具返回经过验证的回执，否则不得声称外部写入成功。
持久化的 E2E 和 MeterSphere 变更必须使用专用的已注册 Workflow。不得从用户文本推断租户、角色、资源或线程标识。`;

export default agentInstructions(async ({ requestContext }) => {
  const runtime = getRuntimeContext(requestContext, {
    allowNativeContext: true,
    allowStudioPreview: config.NODE_ENV === "development",
  });
  const baseInstructions = runtime.native
    ? nativeQaseyInstructions
    : buildSystemPrompt(runtime["qasey-context"], runtime["intent-route"]).text;
  const casePlan = runtime.native ? undefined : tryCasePlanSummary(requestContext?.get("case-plan"));
  const tooling = await resolveQaseyAgentTooling(requestContext);
  return [baseInstructions, casePlan, tooling.codeModeInstructions].filter(Boolean).join("\n\n");
});
