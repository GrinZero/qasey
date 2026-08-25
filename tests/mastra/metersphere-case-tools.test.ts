import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { meterSphereCommitCasePlanTool } from "../../src/mastra/applications/qasey/metersphere-case-tools.ts";
import { meterSphereCaseOperationWorkflow } from "../../src/mastra/workflows/metersphere-case-workflow.ts";

describe("MeterSphere case commit Tool", () => {
  it("owns dry-run, durable write, fresh read-back, and the completion receipt", async () => {
    const requestContext = testRequestContext();
    const calls: Array<{ toolName: string; input: any }> = [];
    requestContext.set("case-operation-tool-executor", vi.fn(async (toolName: string, input: any) => {
      calls.push({ toolName, input });
      if (toolName === "metersphere_ms_bulk_upsert_test_cases" && input.dry_run === true) {
        return mcpPayload({
          success: true, dry_run: true, validated: true, item_count: 1,
          creates: [{ id: "preview", name: "Case", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
        });
      }
      if (toolName === "metersphere_ms_bulk_upsert_test_cases") {
        return mcpPayload({
          success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
          results: [{ id: "case-1", num: 1, name: "Case", priority: "P1", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
        });
      }
      return { id: "case-1", num: 1, name: "Case", priority: "P1", node_path: "/AI Draft/Feature" };
    }));
    const mastra = new Mastra({ workflows: { "qasey-metersphere-case-operation": meterSphereCaseOperationWorkflow } });
    const items = [{ operation: "create", name: "Case", priority: "P1", node_id: "module", node_path: "/AI Draft/Feature" }];

    const receipt = await executeCommit(items, mastra, requestContext);

    expect(receipt).toMatchObject({
      verificationMode: "separate_read_back",
      caseOperation: { itemCount: 1, createdCount: 1, verifiedCount: 1 },
    });
    expect(requestContext.get("case-completion-receipt")).toEqual(receipt);
    expect(calls.map(call => [call.toolName, call.input.dry_run])).toEqual([
      ["metersphere_ms_bulk_upsert_test_cases", true],
      ["metersphere_ms_bulk_upsert_test_cases", false],
      ["metersphere_ms_get_test_case_detail", undefined],
    ]);

    await expect(executeCommit(items, mastra, requestContext)).resolves.toEqual(receipt);
    expect(calls.filter(call => call.toolName === "metersphere_ms_bulk_upsert_test_cases" && call.input.dry_run === false)).toHaveLength(1);
  });

  it("rejects a different case plan after one request has committed", async () => {
    const requestContext = testRequestContext();
    requestContext.set("case-plan", { planHash: "already-committed" });
    requestContext.set("case-operation-tool-executor", async () => mcpPayload({
      success: true, dry_run: true, validated: true, item_count: 1,
      creates: [{ id: "preview", name: "Other", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
    }));
    const mastra = new Mastra({ workflows: { "qasey-metersphere-case-operation": meterSphereCaseOperationWorkflow } });

    await expect(executeCommit([
      { operation: "create", name: "Other", priority: "P1", node_id: "module", node_path: "/AI Draft/Feature" },
    ], mastra, requestContext)).rejects.toThrow(/already committed a different/i);
  });
});

async function executeCommit(items: Array<Record<string, unknown>>, mastra: Mastra, requestContext: RequestContext<any>) {
  const execute = meterSphereCommitCasePlanTool.execute!;
  return execute({ items }, {
    mastra,
    requestContext,
    abortSignal: new AbortController().signal,
    observe: { span: async (_name: string, operation: () => Promise<unknown>) => operation(), log: () => undefined },
  } as never);
}

function testRequestContext(): RequestContext<any> {
  const requestContext = new RequestContext<any>();
  const context: QaseyRequestContext = {
    requestId: "request-1", channel: "api", sessionId: "session-1", chatInput: "create cases",
    actor: { id: "actor-1" }, source: {}, attachments: [],
  };
  requestContext.set("qasey-context", context);
  requestContext.set("qasey-agent-run-id", "agent-run-1");
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
