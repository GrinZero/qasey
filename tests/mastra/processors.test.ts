import { MessageList } from "@mastra/core/agent/message-list";
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import { ToolCallFilter } from "@mastra/core/processors";
import { describe, expect, it, vi } from "vitest";
import {
  createQaseyContextProcessors,
  EnsureQaseyFinalResponseProcessor,
  QASEY_AGENT_MAX_STEPS,
} from "../../src/mastra/agents/qasey-main/processors.ts";

describe("qasey-main processors", () => {
  it("keeps compact model-facing tool history before applying the token limit", () => {
    expect(createQaseyContextProcessors().map(processor => processor.id)).toEqual([
      "tool-call-filter",
      "qasey-ensure-final-response",
      "token-limiter",
    ]);
  });

  it("preserves compact model output in the prompt without mutating raw memory", async () => {
    const rawResult = { content: "x".repeat(50_000) };
    const message: MastraDBMessage = {
      id: "message-1",
      role: "assistant",
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [{
          type: "tool-invocation",
          toolInvocation: {
            state: "result",
            toolCallId: "tool-call-1",
            toolName: "github_get_file",
            args: { path: "README.md" },
            result: rawResult,
          },
          providerMetadata: {
            mastra: { modelOutput: { type: "text", value: "compact result" } },
          },
        }],
      },
    };
    const messageList = new MessageList();
    messageList.add([message], "memory");
    const filter = new ToolCallFilter({ preserveModelOutput: true });

    const filtered = await filter.processInput({
      messages: [],
      messageList,
      abort: reason => { throw new Error(reason); },
    });

    expect(filtered).toEqual([expect.objectContaining({
      content: expect.objectContaining({
        parts: [{ type: "text", text: "github_get_file result:\ncompact result" }],
      }),
    })]);
    expect(messageList.get.all.db()[0]?.content.parts[0]).toMatchObject({
      type: "tool-invocation",
      toolInvocation: { result: rawResult },
    });
  });

  it("forces a text-only last step using a static durable-safe processor", async () => {
    const sendSignal = vi.fn();
    const processor = new EnsureQaseyFinalResponseProcessor();

    await expect(processor.processInputStep({
      stepNumber: QASEY_AGENT_MAX_STEPS - 2,
      sendSignal,
    } as never)).resolves.toEqual({});
    await expect(processor.processInputStep({
      stepNumber: QASEY_AGENT_MAX_STEPS - 1,
      sendSignal,
    } as never)).resolves.toEqual({ toolChoice: "none" });
    expect(sendSignal).toHaveBeenCalledWith(expect.objectContaining({
      type: "reactive",
      attributes: { reason: "max-steps-reached", step: QASEY_AGENT_MAX_STEPS },
    }));
  });
});
