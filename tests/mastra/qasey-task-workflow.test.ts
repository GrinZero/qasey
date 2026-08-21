import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { buildMeterSphereCasePlan } from "../../packages/domain/src/index.ts";
import { qaseyTaskWorkflow, runQaseyTaskWorkflow } from "../../src/mastra/workflows/qasey-task-workflow.ts";
import { prepareQaseyRequestContext } from "../../src/mastra/applications/qasey/service.ts";

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
  runId: "workflow-run-1",
  outcome: "success" as const,
  finalization: "agent" as const,
  progress: [],
};

describe("qasey-task workflow", () => {
  it("lets qasey-main select a Skill before workflow finalization", () => {
    const graph = qaseyTaskWorkflow.serializedStepGraph as Array<Record<string, any>>;
    expect(graph.map(entry => entry.step?.id ?? entry.type)).toEqual([
      "run-skill-driven-agent",
      "determine-finalization",
      "conditional",
      "assemble-response",
    ]);
    const branch = graph.find(entry => entry.type === "conditional")!;
    expect(branch.steps.map((entry: Record<string, any>) => entry.step?.id ?? entry.id)).toEqual([
      "finalize-agent-response",
      "qasey-metersphere-case-finalization",
    ]);
    const caseFinalization = branch.steps.find((entry: Record<string, any>) => entry.id === "qasey-metersphere-case-finalization")!;
    const caseOperation = caseFinalization.serializedStepFlow.find(
      (entry: Record<string, any>) => entry.id === "qasey-metersphere-case-operation",
    )!;
    expect(caseOperation.serializedStepFlow.map((entry: Record<string, any>) => entry.step.id)).toEqual([
      "freeze-dry-run-plan",
      "write-frozen-plan",
      "verify-fresh-read-back",
      "checkpoint-completion",
    ]);
  });

  it("starts the registered native workflow with trusted request context", async () => {
    const start = vi.fn(async (_options: { inputData: QaseyRequestContext; requestContext: { get: (key: string) => unknown } }) => ({
      status: "success" as const,
      result: response,
    }));
    const createRun = vi.fn(async () => ({ start }));
    const mastra = { getWorkflow: vi.fn(() => ({ createRun })) } as unknown as Mastra;

    const tracingContext = { currentSpan: { id: "channel-span" } as never };
    await expect(runQaseyTaskWorkflow(mastra, context, {
      runId: "workflow-run-1",
      tracingContext,
    })).resolves.toEqual(response);

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "workflow-run-1",
      resourceId: "qasey:tenant-1:user-1",
    }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      inputData: context,
      requestContext: expect.objectContaining({ get: expect.any(Function) }),
      tracingContext,
    }));
    const requestContext = start.mock.calls[0]![0].requestContext;
    expect(requestContext.get("applicationId")).toBe("qasey");
    expect(requestContext.get("qasey-context")).toEqual(context);
  });

  it("runs the MeterSphere write path as a native nested workflow with a stable idempotency key", async () => {
    const item = {
      operation: "create",
      name: "Case",
      priority: "P1",
      node_id: "module",
      node_path: "/AI Draft/Feature",
    };
    const plan = buildMeterSphereCasePlan({
      dryRunInput: { dry_run: true, items: JSON.stringify([item]) },
      dryRunResult: mcpPayload({
        success: true,
        dry_run: true,
        item_count: 1,
        creates: [{ id: "preview", name: "Case", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
      }),
    })!;
    const main = new Agent({
      id: "qasey-main",
      name: "Qasey main",
      instructions: "Finish without tools.",
      model: createMockModel({ mockText: "", version: "v2" }),
    });
    const mastra = new Mastra({
      agents: { "qasey-main": main },
      workflows: { "qasey-task": qaseyTaskWorkflow },
    });
    const requestContext = new RequestContext<any>();
    requestContext.set("identity", { userId: "user-1", tenantId: "tenant-1", roles: ["user"], service: false });
    const calls: string[] = [];
    requestContext.set("case-operation-tool-executor", async (toolName: string, input: unknown) => {
      calls.push(toolName);
      if (toolName === "metersphere_ms_bulk_upsert_test_cases") {
        return mcpPayload({
          success: true,
          dry_run: false,
          item_count: 1,
          created_count: 1,
          updated_count: 0,
          results: [{
            id: "case-1",
            num: 1,
            name: "Case",
            priority: "P1",
            node_id: "module",
            node_path: "/AI Draft/Feature",
            verified: true,
          }],
        });
      }
      return {
        id: (input as { case_id: string }).case_id,
        num: 1,
        name: "Case",
        priority: "P1",
        node_path: "/AI Draft/Feature",
      };
    });
    const phases: string[] = [];
    const nestedContext = { ...context, actor: { ...context.actor, tenantId: "tenant-1" } };

    try {
      const result = await runQaseyTaskWorkflow(mastra, nestedContext, {
        requestContext,
        runId: "qasey-native-nested-test",
        resumeCasePlan: plan,
        events: { onPhase: event => { phases.push(event.phase); } },
      });

      expect(result).toMatchObject({
        outcome: "success",
        finalization: "workflow",
        completionReceipt: { casePlanHash: plan.planHash, verificationMode: "separate_read_back" },
      });
      expect(phases).toEqual(["agent", "workflow", "finalizing"]);
      expect(calls).toEqual([
        "metersphere_ms_bulk_upsert_test_cases",
        "metersphere_ms_get_test_case_detail",
      ]);
      expect(requestContext.get("externalWriteIdempotencyKey")).toMatch(
        /qasey-metersphere-case-operation:metersphere-case-[a-f0-9]{32}:metersphere-case-write/u,
      );
    } finally {
      await mastra.shutdown();
    }
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

function mcpPayload(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify([value]) }] };
}
