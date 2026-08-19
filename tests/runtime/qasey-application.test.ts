import { describe, expect, it } from "vitest";
import {
  createQaseyApplication,
  type QaseyApplicationModules,
} from "../../src/agent-apps/qasey/application.ts";

describe("Qasey application access policy", () => {
  it("exposes primitives to authenticated UI, API, and service callers", async () => {
    const application = await createQaseyApplication({
      agentModule: { qaseyAgent: { id: "qasey-main" } },
      intentModule: { intentRouterAgent: { id: "qasey-intent-router" } },
      taskWorkflowModule: { qaseyTaskWorkflow: { id: "qasey-task" } },
      e2eModule: { e2eLifecycleWorkflow: { id: "qasey-e2e-lifecycle" } },
      scorerModule: { qaseyEvalScorers: { "qasey-quality": { id: "qasey-quality" } } },
      caseWorkflowModule: {
        meterSphereCaseOperationWorkflow: { id: "qasey-metersphere-case-operation" },
      },
      routeModule: { qaseyOwnedApiRoutes: [] },
    } as unknown as QaseyApplicationModules);

    expect(application.access.agents["qasey-main"]?.audiences).toEqual([
      "admin-ui",
      "api",
      "service",
    ]);
    expect(application.access.agents["qasey-main"]?.audiences).not.toContain("channel");
    expect(application.access.agents["qasey-intent-router"]?.audiences).toEqual([
      "admin-ui",
      "api",
      "service",
    ]);
    expect(application.access.agents["qasey-intent-router"]?.audiences).not.toContain("channel");
    for (const workflow of Object.values(application.access.workflows)) {
      expect(workflow.audiences).toEqual(["admin-ui", "api", "service"]);
      expect(workflow.audiences).not.toContain("channel");
    }
    expect(application.access.scorers?.["qasey-quality"]?.audiences).toEqual([
      "admin-ui",
      "api",
      "service",
    ]);
    expect(application.access.scorers?.["qasey-quality"]?.audiences).not.toContain("channel");
    expect(application.access.channels?.slack?.audiences).toEqual(["channel"]);
  });
});
