import type { Mastra } from "@mastra/core/mastra";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { qaseyTaskWorkflow, runQaseyTaskWorkflow } from "../../src/mastra/qasey-task-workflow.ts";
import { prepareQaseyRequestContext } from "../../src/mastra/service.ts";

const context: QaseyRequestContext = {
  requestId: "request-1",
  channel: "api",
  sessionId: "session-1",
  chatInput: "review FIN-1",
  actor: { id: "user-1", tenantId: "tenant-1" },
  source: {},
  attachments: [],
};

const response = {
  text: "review complete",
  route: {
    version: 2 as const,
    intent: "qa_review" as const,
    relation: "new" as const,
    writeTarget: "none" as const,
    depth: "standard" as const,
    confidence: 1,
    reason: "test",
    routerStatus: "ok" as const,
  },
  runId: "workflow-run-1",
  outcome: "success" as const,
  finalization: "agent" as const,
  evidenceStats: {
    actualExecutions: 0,
    deduplicatedCalls: 0,
    cachedFailures: 0,
    artifactReads: 0,
    artifactizedResults: 0,
    totalResultChars: 0,
    duplicateResultCharsAvoided: 0,
  },
  progress: [],
};

describe("qasey-task workflow", () => {
  it("classifies intent before executing the route-scoped Qasey agent", () => {
    const graph = qaseyTaskWorkflow.serializedStepGraph as Array<{ step: { id: string } }>;
    expect(graph.map(entry => entry.step.id)).toEqual([
      "classify-intent",
      "execute-routed-qasey",
    ]);
  });

  it("starts the registered native workflow with trusted request context", async () => {
    const start = vi.fn(async (_options: { inputData: QaseyRequestContext; requestContext: { get: (key: string) => unknown } }) => ({
      status: "success" as const,
      result: response,
    }));
    const createRun = vi.fn(async () => ({ start }));
    const mastra = { getWorkflow: vi.fn(() => ({ createRun })) } as unknown as Mastra;

    await expect(runQaseyTaskWorkflow(mastra, context, { runId: "workflow-run-1" })).resolves.toEqual(response);

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "workflow-run-1",
      resourceId: "qasey:tenant-1:user-1",
    }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      inputData: context,
      requestContext: expect.objectContaining({ get: expect.any(Function) }),
    }));
    const requestContext = start.mock.calls[0]![0].requestContext;
    expect(requestContext.get("applicationId")).toBe("qasey");
    expect(requestContext.get("qasey-context")).toEqual(context);
  });

  it("lets task ingress choose an isolated thread while preserving server-owned resource scope", () => {
    const requestContext = new RequestContext();
    requestContext.set("identity", { userId: "user-1", tenantId: "tenant-1", roles: ["user"], service: false });
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "qasey:tenant-1:user-1");

    const prepared = prepareQaseyRequestContext({ ...context, requestId: "request-2", sessionId: "request-2" }, requestContext);

    expect(prepared.get(MASTRA_RESOURCE_ID_KEY)).toBe("qasey:tenant-1:user-1");
    expect(prepared.get(MASTRA_THREAD_ID_KEY)).toBe("qasey:tenant-1:private:request-2");
    expect(prepared.get("sessionId")).toBe("request-2");
  });
});
