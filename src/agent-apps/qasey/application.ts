import type { AgentApplicationBundle } from "../../runtime/application.ts";

export interface QaseyApplicationModules {
  agentModule: Pick<typeof import("../../mastra/qasey-agent.ts"), "qaseyAgent">;
  intentModule: Pick<typeof import("../../mastra/intent-agent.ts"), "intentRouterAgent">;
  taskWorkflowModule: Pick<typeof import("../../mastra/qasey-task-workflow.ts"), "qaseyTaskWorkflow">;
  e2eModule: Pick<typeof import("../../mastra/e2e-workflow.ts"), "e2eLifecycleWorkflow">;
  scorerModule: Pick<typeof import("../../mastra/eval-scorers.ts"), "qaseyEvalScorers">;
  caseWorkflowModule: Pick<typeof import("../../mastra/metersphere-case-workflow.ts"), "meterSphereCaseOperationWorkflow">;
  routeModule: Pick<typeof import("../../mastra/routes.ts"), "qaseyOwnedApiRoutes">;
}

/**
 * Public Qasey catalog. Intent routing remains an internal Agent. The
 * MeterSphere workflow is registered only because durable snapshots require
 * the runtime lifecycle, and its service-only policy blocks public callers.
 *
 * Primitive modules are intentionally loaded only when the composition root
 * invokes this factory. Importing an Application definition must not construct
 * storage, MCP clients, workspaces, or domain repositories.
 */
export async function createQaseyApplication(
  provided?: QaseyApplicationModules,
): Promise<AgentApplicationBundle> {
  const modules = provided ?? await loadQaseyApplicationModules();
  const { agentModule, intentModule, taskWorkflowModule, e2eModule, scorerModule, caseWorkflowModule, routeModule } = modules;
  const qaseyEvalScorers = scorerModule.qaseyEvalScorers;
  return {
    id: "qasey",
    ui: {
      name: "Qasey",
      description: "从需求分析到自动化验证，交付可追溯的 QA 结论。",
      category: "Quality Engineering",
      capabilities: ["需求分析", "测试运行", "证据审阅"],
      homePath: "/admin#apps/qasey",
      accent: "indigo",
    },
    agents: {
      "qasey-main": agentModule.qaseyAgent,
      "qasey-intent-router": intentModule.intentRouterAgent,
    },
    workflows: {
      "qasey-task": taskWorkflowModule.qaseyTaskWorkflow,
      "qasey-e2e-lifecycle": e2eModule.e2eLifecycleWorkflow,
      "qasey-metersphere-case-operation": caseWorkflowModule.meterSphereCaseOperationWorkflow,
    },
    scorers: qaseyEvalScorers,
    access: {
      agents: {
        // Public API and channel callers enter through qasey-task so intent
        // routing and deterministic completion checks cannot be bypassed.
        // The OAuth/RBAC-protected Studio remains available for inspection.
        "qasey-main": { permission: "qasey.agent.execute", audiences: ["admin-ui", "service"] },
        "qasey-intent-router": { permission: "qasey.intent.route", audiences: ["admin-ui", "service"] },
      },
      workflows: {
        "qasey-task": { permission: "qasey.task.execute", audiences: ["service"] },
        // User lifecycle mutations go through owner-scoped domain routes. Keeping
        // the native workflow service-only prevents resume from bypassing QA RBAC.
        "qasey-e2e-lifecycle": { permission: "qasey.e2e.execute", audiences: ["service"] },
        "qasey-metersphere-case-operation": { permission: "qasey.case-workflow.execute", audiences: ["service"] },
      },
      scorers: Object.fromEntries(Object.keys(qaseyEvalScorers).map(id => [
        id,
        { permission: "qasey.scorers.read", audiences: ["admin-ui", "service"] },
      ])),
      channels: {
        slack: { permission: "qasey.channel.receive", audiences: ["channel"] },
      },
    },
    routes: routeModule.qaseyOwnedApiRoutes,
  };
}

async function loadQaseyApplicationModules(): Promise<QaseyApplicationModules> {
  const [agentModule, intentModule, taskWorkflowModule, e2eModule, scorerModule, caseWorkflowModule, routeModule] = await Promise.all([
    import("../../mastra/qasey-agent.ts"),
    import("../../mastra/intent-agent.ts"),
    import("../../mastra/qasey-task-workflow.ts"),
    import("../../mastra/e2e-workflow.ts"),
    import("../../mastra/eval-scorers.ts"),
    import("../../mastra/metersphere-case-workflow.ts"),
    import("../../mastra/routes.ts"),
  ]);
  return { agentModule, intentModule, taskWorkflowModule, e2eModule, scorerModule, caseWorkflowModule, routeModule };
}
