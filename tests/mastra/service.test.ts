import type { Mastra } from "@mastra/core/mastra";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import {
  agentRuntimeEventFromChunk,
  assertNormalCompletion,
  executeQasey,
  QaseyResponseSchema,
  restoreProcessedAgentOutput,
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

  it("preserves informative Agent lifecycle payloads for channel projection", () => {
    expect(agentRuntimeEventFromChunk("run-1", 0, {
      type: "step-start",
      runId: "run-1",
      from: "AGENT",
      payload: { request: {}, inputMessages: [{ role: "user", content: [{ type: "text", text: "review FIN-1" }] }] },
    } as any)).toMatchObject({ type: "step-start", step: 1 });
    expect(agentRuntimeEventFromChunk("run-1", 1, {
      type: "tool-call",
      runId: "run-1",
      from: "AGENT",
      payload: { toolCallId: "call-1", toolName: "jira_get_issue", args: { issueKey: "FIN-1" } },
    } as any)).toMatchObject({ type: "tool-call", step: 1, args: { issueKey: "FIN-1" } });
    expect(agentRuntimeEventFromChunk("run-1", 1, {
      type: "tool-result",
      runId: "run-1",
      from: "AGENT",
      payload: { toolCallId: "call-1", toolName: "jira_get_issue", result: { summary: "Payment migration" } },
    } as any)).toMatchObject({ type: "tool-result", result: { summary: "Payment migration" }, isError: false });
    expect(agentRuntimeEventFromChunk("run-1", 1, {
      type: "step-finish",
      runId: "run-1",
      from: "AGENT",
      payload: {
        stepResult: { reason: "tool-calls" },
        output: { text: "已确认 Payment migration", usage: {}, toolCalls: [] },
        metadata: {},
      },
    } as any)).toMatchObject({ type: "step-finish", text: "已确认 Payment migration" });
  });

  it("consumes the Agent full stream and forwards lifecycle events", async () => {
    const runtimeEvents: string[] = [];
    const cleanup = vi.fn();
    const mastra = mockMastra(async () => ({
      finishReason: "stop",
      text: "review complete",
      steps: [{ finishReason: "stop", text: "review complete", toolCalls: [], toolResults: [] }],
    }), [
      { type: "step-start", runId: "run-1", from: "AGENT", payload: { request: {}, inputMessages: [] } },
      { type: "tool-call", runId: "run-1", from: "AGENT", payload: { toolCallId: "call-1", toolName: "jira_get_issue", args: { issueKey: "FIN-1" } } },
      { type: "tool-result", runId: "run-1", from: "AGENT", payload: { toolCallId: "call-1", toolName: "jira_get_issue", result: { summary: "Payment migration" } } },
      { type: "step-finish", runId: "run-1", from: "AGENT", payload: { stepResult: { reason: "stop" }, output: { text: "review complete", usage: {}, toolCalls: [] }, metadata: {} } },
    ], cleanup);

    await executeQasey(mastra, context, {
      events: { onAgentRuntimeEvent: event => { runtimeEvents.push(`${event.step}:${event.type}`); } },
    });

    expect(runtimeEvents).toEqual(["1:step-start", "1:tool-call", "1:tool-result", "1:step-finish"]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("restores aggregate fields that durable stream batching omits", () => {
    expect(restoreProcessedAgentOutput(
      { text: "", steps: [{ text: "", finishReason: "tool-calls" }], finishReason: "tool-calls" },
      { text: "OK", steps: [{ text: "", finishReason: "tool-calls" }, { text: "OK", finishReason: "stop" }], finishReason: "stop" },
    )).toMatchObject({
      text: "OK",
      steps: [{ finishReason: "tool-calls" }, { text: "OK", finishReason: "stop" }],
      finishReason: "stop",
    });
  });

  it("validates the direct Agent response contract", () => {
    expect(QaseyResponseSchema.parse({
      text: "review complete",
      runId: "run-1",
      outcome: "success",
      finalization: "agent",
      progress: [],
    })).toMatchObject({ finalization: "agent", text: "review complete" });
  });

  it("does not install Ledger control and does not stop on Skill/search_tools iterations", async () => {
    const iterationNames: string[][] = [];
    const toolEvents: string[] = [];
    const runAgent = vi.fn(async (_prompt: unknown, options: Record<string, any>) => {
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
    const mastra = mockMastra(runAgent);

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

});

function mockMastra(
  runAgent: (prompt: unknown, options: Record<string, any>) => Promise<Record<string, unknown>>,
  chunks: any[] = [],
  cleanup: () => void = () => {},
): Mastra {
  return {
    getAgent: () => ({
      stream: async (prompt: unknown, options: Record<string, any>) => {
        const output = await runAgent(prompt, options);
        return {
          fullStream: new ReadableStream({
            start: controller => {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          output: {
            getFullOutput: async () => output,
          },
          cleanup,
        };
      },
    }),
  } as unknown as Mastra;
}
