import type { Mastra } from "@mastra/core/mastra";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import type { MeterSphereCaseCompletionReceipt } from "../../packages/domain/src/index.ts";
import {
  assertNormalCompletion,
  completionReceiptText,
  executeQasey,
  extractMeterSphereCasePlan,
  selectFinalText,
} from "../../src/mastra/applications/qasey/service.ts";

const context: QaseyRequestContext = {
  requestId: "request-1",
  channel: "api",
  sessionId: "thread-1",
  chatInput: "review FIN-1",
  actor: { id: "actor-1" },
  source: {},
  attachments: [],
};

describe("Qasey service completion", () => {
  it("selects only final-step text and validates native completion", () => {
    expect(selectFinalText({
      text: "progressfinal",
      steps: [{ text: "progress" }, { text: "final" }],
    })).toBe("final");
    expect(() => assertNormalCompletion({
      finishReason: "stop",
      steps: [{
        finishReason: "stop",
        toolCalls: [{ payload: { toolCallId: "call-1" } }],
        toolResults: [{ payload: { toolCallId: "call-1" } }],
      }],
    })).not.toThrow();
    expect(() => assertNormalCompletion({ finishReason: "tool-calls", steps: [] })).toThrow(/normally/i);
  });

  it("renders a workflow-owned completion receipt", () => {
    expect(completionReceiptText(completionReceipt("plan"))).toContain("独立回查通过 1/1");
  });

  it("extracts a deterministic CasePlan from native Mastra tool results", () => {
    const input = dryRunInput();
    const output = dryRunOutput();
    const plan = extractMeterSphereCasePlan({
      steps: [{
        toolCalls: [{
          type: "tool-call",
          payload: { toolCallId: "dry-run", toolName: "metersphere_ms_bulk_upsert_test_cases", args: input },
        }],
        toolResults: [{
          type: "tool-result",
          payload: { toolCallId: "dry-run", toolName: "metersphere_ms_bulk_upsert_test_cases", result: output },
        }],
      }],
    });

    expect(plan).toMatchObject({ plannedCount: 1, cases: [{ name: "Case", order: 1 }] });
    expect(plan).not.toHaveProperty("evidenceSnapshotHash");
  });

  it("does not install Ledger control and does not stop on Skill/search_tools iterations", async () => {
    const iterationNames: string[][] = [];
    const toolEvents: string[] = [];
    const generate = vi.fn(async (_prompt: unknown, options: Record<string, any>) => {
      expect(options.prepareStep).toBeUndefined();
      expect(options.requestContext.get("evidence-ledger")).toBeUndefined();
      for (const [index, name] of ["skill", "search_tools", "search_tools"].entries()) {
        const directive = await options.onIterationComplete({
          iteration: index + 1,
          toolCalls: [{ id: `call-${index}`, name, args: {} }],
          toolResults: [{ id: `call-${index}`, name, result: { ok: true } }],
          text: "",
          finishReason: "tool-calls",
          isFinal: false,
        });
        expect(directive).toBeUndefined();
      }
      await options.hooks.beforeToolCall({ toolName: "github_get_file", input: { path: "README.md" } });
      await options.hooks.afterToolCall({ toolName: "github_get_file", output: { ok: true } });
      return {
        finishReason: "stop",
        text: "review complete",
        steps: [{ finishReason: "stop", text: "review complete", toolCalls: [], toolResults: [] }],
      };
    });
    const mastra = { getAgent: () => ({ generate }) } as unknown as Mastra;

    const response = await executeQasey(mastra, context, {
      events: {
        onIteration: event => { iterationNames.push(event.toolNames); },
        onToolStart: event => { toolEvents.push(`start:${event.toolName}`); },
        onToolEnd: event => { toolEvents.push(`end:${event.toolName}:${event.disposition}`); },
      },
    });

    expect(response).toMatchObject({ outcome: "success", finalization: "agent", text: "review complete" });
    expect(response).not.toHaveProperty("evidenceStats");
    expect(iterationNames).toEqual([["skill"], ["search_tools"], ["search_tools"]]);
    expect(toolEvents).toEqual(["start:github_get_file", "end:github_get_file:executed"]);
  });

  it("hands an extracted dry-run plan to the deterministic Workflow", async () => {
    const input = dryRunInput();
    const output = dryRunOutput();
    const generate = vi.fn(async () => ({
      finishReason: "stop",
      text: "plan ready",
      steps: [{
        finishReason: "tool-calls",
        text: "",
        toolCalls: [{ payload: { toolCallId: "dry-run", toolName: "metersphere_ms_bulk_upsert_test_cases", args: input } }],
        toolResults: [{ payload: { toolCallId: "dry-run", toolName: "metersphere_ms_bulk_upsert_test_cases", result: output } }],
      }, { finishReason: "stop", text: "plan ready", toolCalls: [], toolResults: [] }],
    }));
    const caseOperationRunner = vi.fn(async ({ plan }: { plan: { planHash: string } }) => completionReceipt(plan.planHash));
    const plans: string[] = [];
    const mastra = { getAgent: () => ({ generate }) } as unknown as Mastra;

    const response = await executeQasey(mastra, { ...context, chatInput: "create cases" }, {
      caseOperationRunner,
      events: { onCasePlanCheckpoint: event => { plans.push(event.plan.planHash); } },
    });

    expect(caseOperationRunner).toHaveBeenCalledTimes(1);
    expect(plans).toHaveLength(1);
    expect(response).toMatchObject({
      outcome: "success",
      finalization: "workflow",
      completionReceipt: { casePlanHash: plans[0] },
    });
  });
});

function dryRunInput() {
  return {
    dry_run: true,
    items: JSON.stringify([{
      operation: "create",
      name: "Case",
      priority: "P1",
      node_id: "module",
      node_path: "/AI Draft/Feature",
    }]),
  };
}

function dryRunOutput() {
  return {
    content: [{ type: "text", text: JSON.stringify([{
      success: true,
      dry_run: true,
      item_count: 1,
      creates: [{ id: "preview", name: "Case", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
    }]) }],
  };
}

function completionReceipt(casePlanHash: string): MeterSphereCaseCompletionReceipt {
  return {
    casePlanHash,
    verificationMode: "separate_read_back",
    caseOperation: {
      moduleId: "module",
      modulePath: "/AI Draft/Feature",
      featureName: "Feature",
      cases: [{
        id: "case-1",
        num: 1,
        name: "Case",
        priority: "P1",
        verified: true,
        nodeId: "module",
        nodePath: "/AI Draft/Feature",
      }],
      itemCount: 1,
      createdCount: 1,
      updatedCount: 0,
      verifiedCount: 1,
      verificationMode: "separate_read_back",
    },
  };
}
