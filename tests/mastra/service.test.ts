import type { Mastra } from "@mastra/core/mastra";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import type { EvidenceCompletionReceipt } from "../../packages/domain/src/evidence-ledger.ts";
import { buildMeterSphereCasePlan } from "../../packages/domain/src/index.ts";
import { assertNormalCompletion, completionReceiptText, executeQasey, selectFinalText } from "../../src/mastra/applications/qasey/service.ts";

describe("Qasey service completion", () => {
  it("selects only the final step text instead of accumulated progress text", () => {
    expect(selectFinalText({
      text: "progress oneprogress twofinal answer",
      steps: [{ text: "progress one" }, { text: "progress two" }, { text: "final answer" }],
    })).toBe("final answer");
  });

  it("does not fall back to accumulated text when steps exist without a final answer", () => {
    expect(selectFinalText({ text: "progress only", steps: [{ text: "progress only" }, { text: "" }] })).toBe("");
  });

  it("rejects non-normal finish reasons", () => {
    expect(() => assertNormalCompletion({ finishReason: "tool-calls", steps: [] })).toThrow(/did not finish normally/i);
  });

  it("rejects unfinished tool calls", () => {
    expect(() => assertNormalCompletion({
      finishReason: "stop",
      steps: [{
        finishReason: "stop",
        toolCalls: [{ payload: { toolCallId: "call-1" } }],
        toolResults: [],
      }],
    })).toThrow(/unfinished tool call/i);
  });

  it("accepts a normal result with matched tool results", () => {
    expect(() => assertNormalCompletion({
      finishReason: "stop",
      steps: [{
        finishReason: "stop",
        toolCalls: [{ payload: { toolCallId: "call-1" } }],
        toolResults: [{ payload: { toolCallId: "call-1" } }],
      }],
    })).not.toThrow();
  });

  it("builds a deterministic final response from a verified completion receipt", () => {
    expect(completionReceiptText({
      casePlanHash: "plan",
      write: { sourceKey: "write", toolName: "write", status: "acquired", attempts: 1 },
      verification: { sourceKey: "verify", toolName: "verify", status: "acquired", attempts: 1 },
      verificationMode: "separate_read_back",
      caseOperation: {
        moduleId: "module",
        modulePath: "/AI Draft/Split Payment",
        featureName: "Split Payment",
        cases: [{ id: "case", num: 1, name: "Case", priority: "P1", verified: true }],
        itemCount: 1,
        createdCount: 1,
        updatedCount: 0,
        verifiedCount: 1,
        verificationMode: "separate_read_back",
      },
    })).toContain("独立回查通过 1/1");
  });

  it("records one business trace and parents both agents under it", async () => {
    const context: QaseyRequestContext = {
      requestId: "request-1",
      channel: "slack",
      sessionId: "thread-1",
      chatInput: "review FIN-1",
      actor: { id: "actor-1" },
      source: { issueKey: "FIN-1" },
      attachments: [],
    };
    const rootSpan = {
      update: vi.fn(),
      end: vi.fn(),
      error: vi.fn(),
    };
    const startSpan = vi.fn(() => rootSpan);
    const qaseyGenerate = vi.fn(async (..._args: unknown[]) => ({
      finishReason: "stop",
      text: "review complete",
      steps: [{ finishReason: "stop", text: "review complete", toolCalls: [], toolResults: [] }],
    }));
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan }) },
      getAgent: () => ({ generate: qaseyGenerate }),
    } as unknown as Mastra;

    const response = await executeQasey(mastra, context, {
      trace: {
        jobId: "job-1",
        eventId: "event-1",
        attempt: 2,
        triggerSource: "slack",
        triggerEventType: "app_mention",
        triggerTraceId: "trigger-1",
        workerId: "worker-1",
      },
    });

    expect(startSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "qasey request",
      input: expect.objectContaining({ message: "review FIN-1", channel: "slack" }),
      metadata: expect.objectContaining({
        requestId: "request-1",
        threadId: "thread-1",
        jobId: "job-1",
        eventId: "event-1",
        attempt: 2,
      }),
      tags: ["qasey", "channel:slack"],
    }));
    const agentOptions = qaseyGenerate.mock.calls[0]?.[1] as {
      tracingContext?: { currentSpan?: unknown };
      requestContext: { get: (key: string) => unknown };
    } | undefined;
    expect(agentOptions?.tracingContext?.currentSpan).toBe(rootSpan);
    expect(agentOptions?.requestContext.get("requestId")).toBe("request-1");
    expect(agentOptions?.requestContext.get("intent")).toBeUndefined();
    expect(agentOptions?.requestContext.get("jobId")).toBe("job-1");
    expect(rootSpan.update).not.toHaveBeenCalled();
    expect(rootSpan.end).toHaveBeenCalledWith(expect.objectContaining({
      output: expect.objectContaining({
        text: "review complete",
        outcome: "success",
      }),
      metadata: { outcome: "success", finalization: "agent" },
    }));
    expect(rootSpan.error).not.toHaveBeenCalled();
    expect(response).toMatchObject({ text: "review complete", outcome: "success" });
    expect(response).not.toHaveProperty("route");
  });

  it("ends the business trace with an error when the main agent fails", async () => {
    const rootSpan = { update: vi.fn(), end: vi.fn(), error: vi.fn() };
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan: () => rootSpan }) },
      getAgent: () => ({ generate: async () => { throw new Error("model unavailable"); } }),
    } as unknown as Mastra;
    const context: QaseyRequestContext = {
      requestId: "request-error",
      channel: "api",
      sessionId: "thread-error",
      chatInput: "review this",
      actor: { id: "actor-error" },
      source: {},
      attachments: [],
    };

    await expect(executeQasey(mastra, context)).rejects.toThrow("model unavailable");
    expect(rootSpan.end).not.toHaveBeenCalled();
    expect(rootSpan.error).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ message: "model unavailable" }),
      endSpan: true,
      metadata: { outcome: "error" },
    }));
  });

  it("accepts only an independently verified completion checkpoint and ignores model prose", async () => {
    const plan = buildMeterSphereCasePlan({
      dryRunInput: { dry_run: true, items: JSON.stringify([{
        operation: "create", name: "Case", priority: "P1", node_id: "module", node_path: "/AI Draft/Feature",
      }]) },
      dryRunResult: { content: [{ type: "text", text: JSON.stringify([{
        success: true, dry_run: true, item_count: 1,
        creates: [{ id: "preview", name: "Case", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
      }]) }] },
      evidenceSnapshotHash: "evidence",
    })!;
    const receipt: EvidenceCompletionReceipt = {
      casePlanHash: plan.planHash,
      write: { sourceKey: "write", toolName: "metersphere_ms_bulk_upsert_test_cases", status: "acquired", attempts: 1 },
      verification: { sourceKey: "verify", toolName: "metersphere_ms_get_test_case_detail", status: "acquired", attempts: 1 },
      verificationMode: "separate_read_back",
      caseOperation: {
        moduleId: "module", modulePath: "/AI Draft/Feature", featureName: "Feature",
        cases: [{ id: "case", num: 1, name: "Case", priority: "P1", verified: true, nodeId: "module", nodePath: "/AI Draft/Feature" }],
        itemCount: 1, createdCount: 1, updatedCount: 0, verifiedCount: 1,
        verificationMode: "separate_read_back",
      },
    };
    const qaseyGenerate = vi.fn(async (..._args: unknown[]) => ({
      finishReason: "stop",
      text: "The write probably worked. I am still checking it.",
      steps: [{ finishReason: "stop", text: "The write probably worked. I am still checking it.", toolCalls: [], toolResults: [] }],
    }));
    const rootSpan = { update: vi.fn(), end: vi.fn(), error: vi.fn() };
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan: () => rootSpan }) },
      getAgent: () => ({ generate: qaseyGenerate }),
    } as unknown as Mastra;
    const context: QaseyRequestContext = {
      requestId: "request-retry", channel: "slack", sessionId: "thread-retry", chatInput: "create cases",
      actor: { id: "actor" }, source: {}, attachments: [],
    };

    const response = await executeQasey(mastra, context, { resumeCasePlan: plan, resumeReceipt: receipt });
    const agentOptions = qaseyGenerate.mock.calls[0]?.[1] as { prepareStep?: () => unknown } | undefined;
    expect(agentOptions?.prepareStep?.()).toEqual({ activeTools: [], toolChoice: "none" });
    expect(response.completionReceipt).toEqual(receipt);
    expect(response.finalization).toBe("receipt");
    expect(response.text).toContain("独立回查通过 1/1");
    expect(response.text).not.toContain("probably worked");
    expect(rootSpan.error).not.toHaveBeenCalled();
  });

  it("forces a text-only finalization turn and falls back to the durable receipt", async () => {
    const plan = buildMeterSphereCasePlan({
      dryRunInput: { dry_run: true, items: JSON.stringify([{
        operation: "create", name: "Case", priority: "P1", node_id: "module", node_path: "/AI Draft/Feature",
      }]) },
      dryRunResult: { content: [{ type: "text", text: JSON.stringify([{
        success: true, dry_run: true, item_count: 1,
        creates: [{ id: "preview", name: "Case", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
      }]) }] },
      evidenceSnapshotHash: "evidence",
    })!;
    const receipt: EvidenceCompletionReceipt = {
      casePlanHash: plan.planHash,
      write: { sourceKey: "write", toolName: "metersphere_ms_bulk_upsert_test_cases", status: "acquired", attempts: 1 },
      verification: { sourceKey: "verify", toolName: "metersphere_ms_get_test_case_detail", status: "acquired", attempts: 1 },
      verificationMode: "separate_read_back",
      caseOperation: {
        moduleId: "module", modulePath: "/AI Draft/Feature", featureName: "Feature",
        cases: [{ id: "case", num: 1, name: "Case", priority: "P1", verified: true, nodeId: "module", nodePath: "/AI Draft/Feature" }],
        itemCount: 1, createdCount: 1, updatedCount: 0, verifiedCount: 1,
        verificationMode: "separate_read_back",
      },
    };
    let iterationDirective: unknown;
    const qaseyGenerate = vi.fn(async (...args: unknown[]) => {
      const agentOptions = args[1] as {
        onIterationComplete?: (event: {
          iteration: number;
          toolCalls: Array<{ id: string; name: string }>;
          toolResults: Array<{ id: string; name: string; error?: Error }>;
          text: string;
          finishReason: string;
          isFinal: boolean;
        }) => Promise<unknown>;
      };
      iterationDirective = await agentOptions.onIterationComplete?.({
        iteration: 13,
        toolCalls: [{ id: "call-write", name: "metersphere_ms_bulk_upsert_test_cases" }],
        toolResults: [{ id: "call-write", name: "metersphere_ms_bulk_upsert_test_cases" }],
        text: "",
        finishReason: "tool-calls",
        isFinal: true,
      });
      return {
        finishReason: "tool-calls",
        text: "",
        steps: [{
          finishReason: "tool-calls",
          text: "",
          toolCalls: [{ payload: { toolCallId: "call-write" } }],
          toolResults: [{ payload: { toolCallId: "call-write" } }],
        }],
      };
    });
    const rootSpan = { update: vi.fn(), end: vi.fn(), error: vi.fn() };
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan: () => rootSpan }) },
      getAgent: () => ({ generate: qaseyGenerate }),
    } as unknown as Mastra;
    const context: QaseyRequestContext = {
      requestId: "request-receipt-finalization", channel: "slack", sessionId: "thread-receipt-finalization",
      chatInput: "create cases", actor: { id: "actor" }, source: {}, attachments: [],
    };

    const response = await executeQasey(mastra, context, { resumeCasePlan: plan, resumeReceipt: receipt });

    expect(iterationDirective).toEqual({ continue: true });
    expect(response).toMatchObject({
      outcome: "success",
      finalization: "receipt",
      text: expect.stringContaining("独立回查通过 1/1"),
      completionReceipt: receipt,
    });
    expect(rootSpan.end).toHaveBeenCalled();
    expect(rootSpan.error).not.toHaveBeenCalled();

    const pendingRootSpan = { update: vi.fn(), end: vi.fn(), error: vi.fn() };
    const pendingMastra = {
      observability: { getDefaultInstance: () => ({ startSpan: () => pendingRootSpan }) },
      getAgent: () => ({ generate: async () => ({
          finishReason: "tool-calls",
          text: "",
          steps: [{
            finishReason: "tool-calls",
            text: "",
            toolCalls: [{ payload: { toolCallId: "call-pending" } }],
            toolResults: [],
          }],
        }) }),
    } as unknown as Mastra;
    await expect(executeQasey(pendingMastra, context, {
      resumeCasePlan: plan,
      resumeReceipt: receipt,
    })).rejects.toThrow(/unfinished tool call/i);
    expect(pendingRootSpan.end).not.toHaveBeenCalled();
    expect(pendingRootSpan.error).toHaveBeenCalled();
  });

  it("hands a frozen dry-run CasePlan to the deterministic workflow instead of letting the agent write", async () => {
    const item = {
      operation: "create", name: "Case", priority: "P1",
      node_id: "module", node_path: "/AI Draft/Feature",
    };
    let handoffDirective: unknown;
    let planningToolsAfterDryRun: unknown;
    const qaseyGenerate = vi.fn(async (...args: unknown[]) => {
      const agentOptions = args[1] as {
        requestContext: { get: (key: string) => unknown };
        prepareStep: () => unknown;
        onIterationComplete: (event: {
          iteration: number;
          toolCalls: Array<{ id: string; name: string }>;
          toolResults: Array<{ id: string; name: string }>;
          text: string;
          finishReason: string;
          isFinal: boolean;
        }) => Promise<unknown>;
      };
      const ledger = agentOptions.requestContext.get("evidence-ledger") as {
        execute: (toolName: string, input: unknown, operation: () => Promise<unknown>) => Promise<unknown>;
      };
      await ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
        dry_run: true,
        items: JSON.stringify([item]),
      }, async () => ({ content: [{ type: "text", text: JSON.stringify([{
        success: true, dry_run: true, item_count: 1,
        creates: [{ id: "preview", name: "Case", node_id: "module", node_path: "/AI Draft/Feature", verified: true }],
      }]) }] }));
      planningToolsAfterDryRun = agentOptions.prepareStep();
      handoffDirective = await agentOptions.onIterationComplete({
        iteration: 7,
        toolCalls: [{ id: "dry-run", name: "metersphere_ms_bulk_upsert_test_cases" }],
        toolResults: [{ id: "dry-run", name: "metersphere_ms_bulk_upsert_test_cases" }],
        text: "",
        finishReason: "tool-calls",
        isFinal: true,
      });
      return {
        finishReason: "tool-calls",
        text: "",
        steps: [{
          finishReason: "tool-calls",
          text: "",
          toolCalls: [{ payload: { toolCallId: "dry-run" } }],
          toolResults: [{ payload: { toolCallId: "dry-run" } }],
        }],
      };
    });
    const caseOperationRunner = vi.fn(async ({ plan }: { plan: ReturnType<typeof buildMeterSphereCasePlan> extends infer P ? NonNullable<P> : never }) => ({
      casePlanHash: plan.planHash,
      write: { sourceKey: "write", toolName: "metersphere_ms_bulk_upsert_test_cases", status: "acquired" as const, attempts: 1 },
      verification: { sourceKey: "verify", toolName: "metersphere_ms_get_test_case_detail", status: "acquired" as const, attempts: 1 },
      verificationMode: "separate_read_back" as const,
      caseOperation: {
        moduleId: "module", modulePath: "/AI Draft/Feature", featureName: "Feature",
        cases: [{ id: "case", num: 1, name: "Case", priority: "P1", verified: true, nodeId: "module", nodePath: "/AI Draft/Feature" }],
        itemCount: 1, createdCount: 1, updatedCount: 0, verifiedCount: 1,
        verificationMode: "separate_read_back" as const,
      },
    }));
    const phases: string[] = [];
    const plans: string[] = [];
    const receipts: string[] = [];
    const rootSpan = { update: vi.fn(), end: vi.fn(), error: vi.fn() };
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan: () => rootSpan }) },
      getAgent: () => ({ generate: qaseyGenerate }),
    } as unknown as Mastra;
    const context: QaseyRequestContext = {
      requestId: "request-workflow-handoff", channel: "slack", sessionId: "thread-workflow-handoff",
      chatInput: "create cases", actor: { id: "actor" }, source: {}, attachments: [],
    };

    const response = await executeQasey(mastra, context, {
      caseOperationRunner,
      events: {
        onPhase: event => { phases.push(event.phase); },
        onCasePlanCheckpoint: event => { plans.push(event.plan.planHash); },
        onCompletionCheckpoint: event => { receipts.push(event.receipt.casePlanHash); },
      },
    });

    expect(planningToolsAfterDryRun).toEqual({ activeTools: [], toolChoice: "none" });
    expect(handoffDirective).toEqual({ continue: true });
    expect(caseOperationRunner).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      outcome: "success",
      finalization: "workflow",
      text: expect.stringContaining("独立回查通过 1/1"),
    });
    expect(phases).toEqual(["agent", "workflow", "finalizing"]);
    expect(plans).toHaveLength(1);
    expect(receipts).toEqual(plans);
    expect(rootSpan.error).not.toHaveBeenCalled();
  });
});
