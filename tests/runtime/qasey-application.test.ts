import { describe, expect, it } from "vitest";
import {
  createQaseyApplication,
  type QaseyApplicationModules,
} from "../../src/agent-apps/qasey/application.ts";

describe("Qasey application access policy", () => {
  it("allows the protected Mastra Studio to inspect the main agent", async () => {
    const application = await createQaseyApplication({
      agentModule: { qaseyAgent: { id: "qasey-main" } },
      intentModule: { intentRouterAgent: { id: "qasey-intent-router" } },
      taskWorkflowModule: { qaseyTaskWorkflow: { id: "qasey-task" } },
      e2eModule: { e2eLifecycleWorkflow: { id: "qasey-e2e-lifecycle" } },
      scorerModule: { qaseyEvalScorers: {} },
      caseWorkflowModule: {
        meterSphereCaseOperationWorkflow: { id: "qasey-metersphere-case-operation" },
      },
      routeModule: { qaseyOwnedApiRoutes: [] },
    } as unknown as QaseyApplicationModules);

    expect(application.access.agents["qasey-main"]?.audiences).toEqual([
      "admin-ui",
      "service",
    ]);
    expect(application.access.agents["qasey-main"]?.audiences).not.toContain("api");
    expect(application.access.agents["qasey-main"]?.audiences).not.toContain("channel");
  });
});
