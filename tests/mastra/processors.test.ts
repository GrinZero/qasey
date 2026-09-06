import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { ToolCallFilter, type Processor } from "@mastra/core/processors";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  createQaseyContextProcessors,
  EnsureQaseyDeadlineResponseProcessor,
  partitionQaseyDirectTools,
  resolveQaseyMainInputProcessors,
} from "../../src/mastra/agents/qasey-main/processors.ts";
import { mcpCatalog } from "../../src/mastra/runtime.ts";

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
    const guard = processors[0] as Processor;

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
    const filter = createQaseyContextProcessors(["github_get_file"])[0] as ToolCallFilter;
    const prompt = [
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "tool-call-1",
          toolName: "github_get_file",
          input: { path: "README.md" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "tool-call-1",
          toolName: "github_get_file",
          output: { type: "text", value: "compact result" },
        }],
      },
    ] as const;

    const filtered = await filter.processLLMRequest({ prompt, state: {} } as never);

    expect(filtered).toEqual({
      prompt: [{
        role: "assistant",
        content: [{ type: "text", text: "github_get_file result:\ncompact result" }],
      }],
    });
    expect(prompt[0].content[0]).toMatchObject({
      type: "tool-call",
      input: { path: "README.md" },
    });
  });

  it("never removes Skill control results that have no model projection", async () => {
    const filter = createQaseyContextProcessors(["github_get_file"])[0] as ToolCallFilter;
    const prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "github-call-1", toolName: "github_get_file", input: {} },
          { type: "tool-call", toolCallId: "skill-call-1", toolName: "skill", input: { name: "qa-quick-query" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "github-call-1", toolName: "github_get_file", output: "compact" },
          { type: "tool-result", toolCallId: "skill-call-1", toolName: "skill", output: "activated" },
        ],
      },
    ] as const;

    const filtered = await filter.processLLMRequest({ prompt, state: {} } as never);

    expect(filtered).toEqual({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "github_get_file result:\ncompact" },
            expect.objectContaining({ type: "tool-call", toolName: "skill" }),
          ],
        },
        {
          role: "tool",
          content: [expect.objectContaining({ type: "tool-result", toolName: "skill", output: "activated" })],
        },
      ],
    });
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

  it("keeps mutating Case Hub tools out of semantic search", () => {
    const direct = { description: "direct" } as never;
    const optional = { description: "optional" } as never;
    const partitioned = partitionQaseyDirectTools({
      caseHubCreateChangeSet: direct,
      caseHubSearchCases: optional,
      slack_search_messages: optional,
    });

    expect(Object.keys(partitioned.directTools).sort()).toEqual([
      "caseHubCreateChangeSet",
    ]);
    expect(Object.keys(partitioned.searchableTools)).toEqual([
      "caseHubSearchCases",
      "slack_search_messages",
    ]);
  });

  it("injects the trusted Case Hub change-set Tool", async () => {
    const requestContext = new RequestContext<any>();
    requestContext.set("qasey-context", {
      requestId: "request-1", channel: "api", sessionId: "session-1", chatInput: "create cases",
      actor: { id: "actor-1" }, source: {}, attachments: [],
    });
    const discovery = vi.spyOn(mcpCatalog, "toolsForDiscovery").mockResolvedValue({});

    const processors = await resolveQaseyMainInputProcessors({ requestContext });
    const directResult = await (processors[2] as Processor).processInputStep!({ tools: {} } as never) as {
      tools: Record<string, unknown>;
    };

    expect(directResult.tools).toHaveProperty("caseHubCreateChangeSet");
    discovery.mockRestore();
  });
});
