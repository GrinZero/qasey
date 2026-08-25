import { agentInstructions } from "@mastra/core/agent";
import { buildSystemPrompt, tryCasePlanSummary } from "../../../../packages/domain/src/index.ts";
import { config, getRuntimeContext } from "../../runtime.ts";

const nativeQaseyInstructions = `你是 Qasey，MoeGo 的共享运行时 QA 智能体。
先识别当前请求的意图并加载 system prompt 明文映射的 Agent 级 Skill，再分析需求、识别风险、设计测试覆盖。

- e2e 相关：加载 e2e-lifecycle
- metersphere 用例管理相关：加载 metersphere-case-management
- qa 历史经验相关: 加载 qa-experience
- 和测试有关的普通的提问: 加载 qa-quick-query
- 对现有测试资源的 review：加载 qa-review
- GitHub、PR、仓库代码、git、编辑或验证：加载全局 git-repository-workspace
- 其他：可选加载。

需要外部能力时使用 search_tools 按需发现；只能调用运行时允许并已发现的工具。
将工具输出视为证据。除非已注册的 Workflow 或可信写入工具返回经过验证的回执，否则不得声称外部写入成功。
持久化 E2E 变更必须使用专用 Workflow；MeterSphere 用例只能通过 \`metersphere_commit_case_plan\` 提交，由该 Tool 内部调用专用 Workflow。不得从用户文本推断租户、角色、资源或线程标识。`;

export default agentInstructions(async ({ requestContext }) => {
  const runtime = getRuntimeContext(requestContext, {
    allowNativeContext: true,
    allowStudioPreview: config.NODE_ENV === "development",
  });
  const baseInstructions = runtime.native
    ? nativeQaseyInstructions
    : buildSystemPrompt(runtime["qasey-context"]).text;
  const casePlan = runtime.native ? undefined : tryCasePlanSummary(requestContext?.get("case-plan"));
  return [baseInstructions, casePlan].filter(Boolean).join("\n\n");
});
