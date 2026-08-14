import { describe, expect, it } from "vitest";
import { assertNormalCompletion, selectFinalText } from "../../src/mastra/service.ts";

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
});
