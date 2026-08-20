import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { routeIntent } from "../../src/mastra/applications/qasey/intent-routing.ts";

const context: QaseyRequestContext = {
  requestId: "request-route",
  channel: "slack",
  sessionId: "thread-route",
  chatInput: "帮我写一下这个需求的 case",
  actor: { id: "actor-route" },
  source: {},
  attachments: [],
};

describe("model-based intent routing", () => {
  it("sends explicit requests through the model instead of keyword routing", async () => {
    const generate = vi.fn(async () => ({
      object: {
        version: 2,
        intent: "qa_review",
        relation: "new",
        writeTarget: "none",
        depth: "standard",
        confidence: 0.88,
        reason: "model decision",
        routerStatus: "ok",
      },
    }));

    const route = await routeIntent(context, [], undefined, { generate } as never);

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      activeTools: [],
      toolChoice: "none",
      maxSteps: 1,
      structuredOutput: expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: "low", serviceTier: "priority" } },
      }),
    }));
    expect(route).toMatchObject({ intent: "qa_review", reason: "model decision" });
  });

  it("falls back to unknown when the model cannot classify", async () => {
    const route = await routeIntent(context, [], undefined, {
      generate: vi.fn(async () => { throw new Error("router unavailable"); }),
    } as never);

    expect(route).toMatchObject({
      intent: "unknown",
      writeTarget: "none",
      confidence: 0,
      routerStatus: "fallback",
    });
  });
});
