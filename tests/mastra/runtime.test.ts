import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { EvidenceLedger } from "../../packages/domain/src/index.ts";
import { getRuntimeContext, guardToolsWithEvidence, toolsForRequest } from "../../src/mastra/runtime.ts";

describe("Qasey runtime context", () => {
  it("keeps missing context strict for production callers", () => {
    expect(() => getRuntimeContext()).toThrow("Qasey request context has not been initialized");
  });

  it("provides a read-only fallback for Mastra Studio", async () => {
    const runtime = getRuntimeContext(undefined, { allowStudioPreview: true });

    expect(runtime["qasey-context"]).toMatchObject({
      channel: "api",
      sessionId: "mastra-studio",
    });
    expect(runtime["intent-route"]).toMatchObject({
      intent: "unknown",
      writeTarget: "none",
      routerStatus: "fallback",
    });
    await expect(toolsForRequest()).rejects.toThrow("Qasey request context has not been initialized");
  });

  it("rejects partial values injected under Qasey keys by a playground", () => {
    const requestContext = new RequestContext();
    requestContext.set("qasey-context", { mastra__isStudio: true });
    requestContext.set("intent-route", {});

    expect(getRuntimeContext(requestContext, { allowStudioPreview: true })).toEqual(
      getRuntimeContext(undefined, { allowStudioPreview: true }),
    );
    expect(() => getRuntimeContext(requestContext)).toThrow(
      "Qasey request context has not been initialized",
    );
  });

  it("preserves explicitly initialized request context", () => {
    const requestContext = new RequestContext();
    const context: QaseyRequestContext = {
      requestId: "request-1",
      channel: "api",
      sessionId: "session-1",
      chatInput: "review this requirement",
      actor: { id: "actor-1" },
      source: {},
      attachments: [],
    };
    const route: IntentRoute = {
      version: 2,
      intent: "qa_review",
      relation: "new",
      writeTarget: "none",
      depth: "deep",
      confidence: 1,
      reason: "test",
      routerStatus: "ok",
    };
    requestContext.set("qasey-context", context);
    requestContext.set("intent-route", route);

    expect(getRuntimeContext(requestContext, { allowStudioPreview: true })).toEqual({
      "qasey-context": context,
      "intent-route": route,
    });
  });

  it("guards dynamically resolved tools with the request evidence ledger", async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => ({ value }));
    const guarded = guardToolsWithEvidence({
      lookup: createTool({
        id: "lookup",
        description: "test",
        inputSchema: z.object({ value: z.string() }),
        execute,
      }),
    }, new EvidenceLedger("run-guard"));
    const guardedExecute = (guarded.lookup as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute;

    await expect(guardedExecute({ value: "one" }, {})).resolves.toEqual({ value: "one" });
    await expect(guardedExecute({ value: "one" }, {})).resolves.toMatchObject({ status: "already_acquired" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
