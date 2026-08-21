import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { buildMeterSphereCasePlan } from "../../packages/domain/src/index.ts";
import {
  meterSphereCaseOperationWorkflow,
  meterSphereCaseWorkflowRunId,
  runMeterSphereCaseOperationWorkflow,
} from "../../src/mastra/workflows/metersphere-case-workflow.ts";

describe("MeterSphere case operation workflow", () => {
  it("owns the frozen write, performs fresh detail read-back, and checkpoints a receipt", async () => {
    const plan = testPlan();
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const requestContext = testRequestContext();
    requestContext.set("case-plan", plan);
    requestContext.set("case-operation-tool-executor", async (toolName: string, input: unknown) => {
      calls.push({ toolName, input });
      if (toolName === "metersphere_ms_bulk_upsert_test_cases") {
        return mcpPayload({
          success: true,
          dry_run: false,
          item_count: 2,
          created_count: 2,
          updated_count: 0,
          results: [
            { id: "case-1", num: 1, name: "first", priority: "P1", node_id: "leaf-core", node_path: "/AI Draft/Feature/Core", verified: true },
            { id: "case-2", num: 2, name: "second", priority: "P0", node_id: "leaf-callback", node_path: "/AI Draft/Feature/Callback", verified: true },
          ],
        });
      }
      const caseId = (input as { case_id: string }).case_id;
      return caseId === "case-1"
        ? { id: caseId, num: 1, name: "first", priority: "P1", node_path: "/AI Draft/Feature/Core" }
        : { id: caseId, num: 2, name: "second", priority: "P0", node_path: "/AI Draft/Feature/Callback" };
    });
    const mastra = new Mastra({ workflows: { "qasey-metersphere-case-operation": meterSphereCaseOperationWorkflow } });
    const run = await mastra.getWorkflow("qasey-metersphere-case-operation").createRun({ runId: "case-workflow-test" });

    const result = await run.start({ inputData: { plan }, requestContext });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.result.receipt).toMatchObject({
      casePlanHash: plan.planHash,
      verificationMode: "separate_read_back",
      caseOperation: { itemCount: 2, verifiedCount: 2, createdCount: 2 },
    });
    expect(calls.map(call => call.toolName)).toEqual([
      "metersphere_ms_bulk_upsert_test_cases",
      "metersphere_ms_get_test_case_detail",
      "metersphere_ms_get_test_case_detail",
    ]);
    expect(calls[0]?.input).toEqual({ items: JSON.stringify(plan.writeItems), dry_run: false });
  });

  it("fails closed when an independent read-back differs from the frozen plan", async () => {
    const plan = singleCasePlan();
    const requestContext = testRequestContext();
    requestContext.set("case-plan", plan);
    requestContext.set("case-operation-tool-executor", async (toolName: string) => toolName.includes("bulk_upsert")
      ? mcpPayload({
        success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
        results: [{ id: "case-1", num: 1, name: "first", priority: "P1", node_id: "leaf-core", node_path: "/AI Draft/Feature/Core", verified: true }],
      })
      : { id: "case-1", num: 1, name: "drifted", priority: "P1", node_path: "/AI Draft/Feature/Core" });
    const mastra = new Mastra({ workflows: { "qasey-metersphere-case-operation": meterSphereCaseOperationWorkflow } });
    const run = await mastra.getWorkflow("qasey-metersphere-case-operation").createRun({ runId: "case-workflow-mismatch" });

    const result = await run.start({ inputData: { plan }, requestContext });

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toMatch(/did not match CasePlan/i);
  });

  it("reuses a persisted successful workflow result instead of issuing another write", async () => {
    const plan = singleCasePlan();
    const receipt = {
      casePlanHash: plan.planHash,
      verificationMode: "separate_read_back" as const,
      caseOperation: {
        moduleId: "leaf-core", modulePath: "/AI Draft/Feature/Core", featureName: "Core",
        cases: [{ id: "case-1", num: 1, name: "first", priority: "P1", verified: true, nodeId: "leaf-core", nodePath: "/AI Draft/Feature/Core" }],
        itemCount: 1, createdCount: 1, updatedCount: 0, verifiedCount: 1,
        verificationMode: "separate_read_back" as const,
      },
    };
    const createRun = vi.fn();
    const mastra = {
      getWorkflow: () => ({
        getWorkflowRunById: vi.fn(async () => ({ status: "success", result: { receipt } })),
        createRun,
      }),
    } as unknown as Mastra;

    await expect(runMeterSphereCaseOperationWorkflow(
      mastra,
      testRequestContext(),
      plan,
      meterSphereCaseWorkflowRunId("job-1", plan.planHash),
    )).resolves.toEqual(receipt);
    expect(createRun).not.toHaveBeenCalled();
  });
});

function testPlan() {
  const items = [
    { operation: "create", name: "first", priority: "P1", node_id: "leaf-core", node_path: "/AI Draft/Feature/Core" },
    { operation: "create", name: "second", priority: "P0", node_id: "leaf-callback", node_path: "/AI Draft/Feature/Callback" },
  ];
  return buildMeterSphereCasePlan({
    dryRunInput: { dry_run: true, items: JSON.stringify(items) },
    dryRunResult: mcpPayload({
      success: true, dry_run: true, validated: true, item_count: 2,
      creates: items.map((item, index) => ({ id: `preview-${index}`, name: item.name, node_id: item.node_id, node_path: item.node_path, verified: true })),
    }),
  })!;
}

function singleCasePlan() {
  const item = { operation: "create", name: "first", priority: "P1", node_id: "leaf-core", node_path: "/AI Draft/Feature/Core" };
  return buildMeterSphereCasePlan({
    dryRunInput: { dry_run: true, items: JSON.stringify([item]) },
    dryRunResult: mcpPayload({
      success: true, dry_run: true, validated: true, item_count: 1,
      creates: [{ id: "preview", name: item.name, node_id: item.node_id, node_path: item.node_path, verified: true }],
    }),
  })!;
}

function testRequestContext(): RequestContext<any> {
  const requestContext = new RequestContext<any>();
  const context: QaseyRequestContext = {
    requestId: "request-1", channel: "api", sessionId: "session-1", chatInput: "create cases",
    actor: { id: "actor-1" }, source: {}, attachments: [],
  };
  requestContext.set("qasey-context", context);
  requestContext.set("case-operation-phase", "execution");
  requestContext.set("requestId", context.requestId);
  requestContext.set("applicationId", "qasey");
  requestContext.set("channel", "api");
  requestContext.set("ingressSource", "test");
  requestContext.set("identity", { userId: "actor-1", tenantId: "tenant-1", roles: ["user"], service: false });
  requestContext.set("sessionId", context.sessionId);
  requestContext.set("mastra__resourceId", "qasey:tenant-1:actor-1");
  requestContext.set("mastra__threadId", "qasey:tenant-1:private:session-1");
  return requestContext;
}

function mcpPayload(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify([value]) }] };
}
