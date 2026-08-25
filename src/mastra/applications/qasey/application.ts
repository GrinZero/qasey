import type { AgentApplicationBundle } from "../../../runtime/application.ts";

export interface QaseyApplicationModules {
  e2eModule: Pick<typeof import("../../workflows/e2e-workflow.ts"), "e2eLifecycleWorkflow">;
  scorerModule: Pick<typeof import("../../scorers/eval-scorers.ts"), "qaseyEvalScorers">;
  caseWorkflowModule: Pick<typeof import("../../workflows/metersphere-case-workflow.ts"), "meterSphereCaseOperationWorkflow">;
  routeModule: Pick<typeof import("./routes.ts"), "qaseyOwnedApiRoutes">;
}

/**
 * Public Qasey catalog. Intent selection lives inside qasey-main through
 * Agent-level Skills. The MeterSphere workflow is registered because durable snapshots require
 * the runtime lifecycle, and its service-only policy blocks public callers.
 *
 * The composition root supplies code-registered primitives. File-discovered
 * Agents remain catalog metadata here and are instantiated once by the Mastra
 * generated entry. Importing this definition must not construct infrastructure.
 */
export function createQaseyApplication(modules: QaseyApplicationModules): AgentApplicationBundle {
  const { e2eModule, scorerModule, caseWorkflowModule, routeModule } = modules;
  const qaseyEvalScorers = scorerModule.qaseyEvalScorers;
  return {
    id: "qasey",
    ui: {
      name: "Qasey",
      description: "从需求分析到自动化验证，交付可追溯的 QA 结论。",
      category: "Quality Engineering",
      capabilities: ["需求分析", "测试运行", "证据审阅"],
      homePath: "/admin/apps/qasey",
      accent: "indigo",
    },
    agents: {},
    filesystemAgents: ["qasey-main"],
    workflows: {
      "qasey-e2e-lifecycle": e2eModule.e2eLifecycleWorkflow,
      "qasey-metersphere-case-operation": caseWorkflowModule.meterSphereCaseOperationWorkflow,
    },
    scorers: qaseyEvalScorers,
    access: {
      agents: {
        // Authenticated UI, API, and service callers share the same RBAC gate.
        // Signed channel ingress remains isolated to its dedicated adapter.
        "qasey-main": { permission: "qasey.agent.execute", audiences: ["admin-ui", "api", "service"] },
      },
      workflows: {
        "qasey-e2e-lifecycle": { permission: "qasey.e2e.execute", audiences: ["admin-ui", "api", "service"] },
        "qasey-metersphere-case-operation": { permission: "qasey.case-workflow.execute", audiences: ["admin-ui", "api", "service"] },
      },
      scorers: Object.fromEntries(Object.keys(qaseyEvalScorers).map(id => [
        id,
        { permission: "qasey.scorers.read", audiences: ["admin-ui", "api", "service"] },
      ])),
      channels: {
        slack: { permission: "qasey.channel.receive", audiences: ["channel"] },
      },
      protocols: {
        conversations: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api", "service"] },
        responses: { permission: "qasey.agent.execute", audiences: ["admin-ui", "api", "service"] },
      },
    },
    routes: routeModule.qaseyOwnedApiRoutes,
  };
}
