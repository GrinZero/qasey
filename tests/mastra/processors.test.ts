import { MessageList } from "@mastra/core/agent/message-list";
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { ToolCallFilter } from "@mastra/core/processors";
import { describe, expect, it, vi } from "vitest";
import {
  createQaseyContextProcessors,
  EnsureQaseyDeadlineResponseProcessor,
  partitionQaseyDirectTools,
  resolveQaseyMainInputProcessors,
} from "../../src/mastra/agents/qasey-main/processors.ts";

describe("qasey-main processors", () => {
  it("serializes dynamic processor workflows without a request context", async () => {
    const processors = await resolveQaseyMainInputProcessors({
      requestContext: new RequestContext(),
    });

    expect(processors.map(processor => processor.id)).toEqual([
      "qasey-require-request-context",
      "tool-search",
      "qasey-direct-tools",
      "tool-call-filter",
      "qasey-ensure-final-response",
      "token-limiter",
    ]);
  });

  it("lets Mastra register the dynamic processor workflow for Agent metadata", async () => {
    const agent = new Agent({
      id: "qasey-metadata-fixture",
      name: "Qasey metadata fixture",
      instructions: "fixture",
      model: "openai/gpt-5",
      inputProcessors: resolveQaseyMainInputProcessors,
    });

    await expect(agent.getConfiguredProcessorWorkflows()).resolves.toEqual([
      expect.objectContaining({ id: "qasey-metadata-fixture-input-processor" }),
    ]);
  });

  it("keeps missing request context strict when the processor workflow executes", async () => {
    const processors = await resolveQaseyMainInputProcessors({
      requestContext: new RequestContext(),
    });
    const guard = processors[0];

    expect(() => guard?.processInputStep?.({
      requestContext: new RequestContext(),
    } as never)).toThrow("Qasey request context has not been initialized");
  });

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
    const filter = createQaseyContextProcessors(["github_get_file"])[0] as ToolCallFilter;

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

  it("never removes Skill control results that have no model projection", async () => {
    const messageList = new MessageList();
    messageList.add([{
      id: "skill-result",
      role: "assistant",
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [{
          type: "tool-invocation",
          toolInvocation: {
            state: "result",
            toolCallId: "skill-call-1",
            toolName: "skill",
            args: { name: "qa-quick-query" },
            result: "activated",
          },
        }],
      },
    }], "memory");
    const filter = createQaseyContextProcessors(["github_get_file"])[0] as ToolCallFilter;

    const filtered = await filter.processInput({
      messages: [],
      messageList,
      abort: reason => { throw new Error(reason); },
    });

    expect(filtered).toEqual([expect.objectContaining({
      content: expect.objectContaining({
        parts: [expect.objectContaining({
          type: "tool-invocation",
          toolInvocation: expect.objectContaining({ toolName: "skill", result: "activated" }),
        })],
      }),
    })]);
  });

  it("forces a text-only response when the wall-clock deadline approaches", async () => {
    const sendSignal = vi.fn();
    let now = 1_000;
    const processor = new EnsureQaseyDeadlineResponseProcessor(50 * 60_000, 5 * 60_000, () => now);
    const state = {};

    await expect(processor.processInputStep({
      state,
      sendSignal,
    } as never)).resolves.toEqual({});
    now += 45 * 60_000;
    await expect(processor.processInputStep({
      state,
      sendSignal,
    } as never)).resolves.toEqual({ toolChoice: "none" });
    expect(sendSignal).toHaveBeenCalledWith(expect.objectContaining({
      type: "reactive",
      attributes: {
        reason: "deadline-approaching",
        deadlineMs: 3_000_000,
        remainingMs: 300_000,
      },
    }));
  });

  it("keeps MeterSphere case-management tools out of semantic search", () => {
    const direct = { description: "direct" } as never;
    const optional = { description: "optional" } as never;
    const partitioned = partitionQaseyDirectTools({
      metersphere_ms_list_modules: direct,
      metersphere_ms_list_test_cases: direct,
      metersphere_ms_get_test_case_detail: direct,
      metersphere_ms_bulk_upsert_test_cases: direct,
      slack_search_messages: optional,
    });

    expect(Object.keys(partitioned.directTools).sort()).toEqual([
      "metersphere_ms_bulk_upsert_test_cases",
      "metersphere_ms_get_test_case_detail",
      "metersphere_ms_list_modules",
      "metersphere_ms_list_test_cases",
    ]);
    expect(Object.keys(partitioned.searchableTools)).toEqual(["slack_search_messages"]);
  });
});
