import { describe, expect, it } from "vitest";
import {
  createQaseyApplication,
  type QaseyApplicationModules,
} from "../../src/mastra/applications/qasey/application.ts";

describe("Qasey application access policy", () => {
  it("exposes filesystem agents and code primitives to authenticated UI, API, and service callers", () => {
    const application = createQaseyApplication({
      e2eModule: { e2eLifecycleWorkflow: { id: "qasey-e2e-lifecycle" } },
      scorerModule: { qaseyEvalScorers: { "qasey-quality": { id: "qasey-quality" } } },
      caseWorkflowModule: {
        meterSphereCaseOperationWorkflow: { id: "qasey-metersphere-case-operation" },
      },
      routeModule: { qaseyOwnedApiRoutes: [] },
    } as unknown as QaseyApplicationModules);

    expect(application.agents).toEqual({});
    expect(application.filesystemAgents).toEqual(["qasey-main"]);
    expect(application.workflows).not.toHaveProperty("qasey-task");
    expect(application.access.agents["qasey-main"]?.audiences).toEqual([
      "admin-ui",
      "api",
      "service",
    ]);
    expect(application.access.agents["qasey-main"]?.audiences).not.toContain("channel");
    expect(application.access.agents).not.toHaveProperty("qasey-intent-router");
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
