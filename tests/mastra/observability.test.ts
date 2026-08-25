import type { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { SpanType } from "@mastra/core/observability";
import { describe, expect, it, vi } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import {
  startQaseyCorrelatedSpan,
  startQaseyRequestSpan,
} from "../../src/mastra/applications/qasey/observability.ts";

const context: QaseyRequestContext = {
  requestId: "request-1",
  channel: "slack",
  sessionId: "thread-1",
  chatInput: "hello",
  actor: { id: "actor-1", tenantId: "tenant-1" },
  source: {},
  attachments: [],
};

describe("Qasey observability", () => {
  it("parents the business request under the workflow tracing context", () => {
    const childSpan = { id: "child-span", traceId: "trace-1" };
    const createChildSpan = vi.fn(() => childSpan);
    const startSpan = vi.fn();
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan }) },
    } as unknown as Mastra;
    const requestContext = new RequestContext();

    const result = startQaseyRequestSpan(
      mastra,
      requestContext,
      context,
      "run-1",
      {},
      { currentSpan: { createChildSpan } as never },
    );

    expect(createChildSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "qasey request",
      type: SpanType.WORKFLOW_RUN,
      metadata: expect.objectContaining({ requestId: "request-1" }),
    }));
    expect(startSpan).not.toHaveBeenCalled();
    expect(result.tracingContext?.currentSpan).toBe(childSpan);
    expect(requestContext.get("qasey__traceId")).toBe("trace-1");
    expect(requestContext.get("qasey__requestSpanId")).toBe("child-span");
  });

  it("rebuilds a remote workflow parent when no live tracing context is available", () => {
    const remoteSpan = { id: "local-span", traceId: "abc123" };
    const startSpan = vi.fn(() => remoteSpan);
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan }) },
    } as unknown as Mastra;
    const requestContext = new RequestContext();

    const result = startQaseyRequestSpan(
      mastra,
      requestContext,
      context,
      "run-remote",
      {},
      undefined,
      { traceId: "abc123", parentSpanId: "def456" },
    );

    expect(startSpan).toHaveBeenCalledWith(expect.objectContaining({
      type: SpanType.WORKFLOW_RUN,
      traceId: "abc123",
      externalParentSpanId: "def456",
    }));
    expect(result.tracingContext?.currentSpan).toBe(remoteSpan);
  });

  it("correlates dynamic tool-resolution spans without storing a live span in RequestContext", () => {
    const startSpan = vi.fn(() => ({ id: "tools-span", traceId: "trace-1" }));
    const mastra = {
      observability: { getDefaultInstance: () => ({ startSpan }) },
    } as unknown as Mastra;
    const requestContext = new RequestContext();
    requestContext.set("qasey__traceId", "trace-1");
    requestContext.set("qasey__requestSpanId", "request-span");

    startQaseyCorrelatedSpan(mastra, requestContext, "qasey tools resolve", { intent: "meta_or_out_of_scope" });

    expect(startSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "qasey tools resolve",
      traceId: "trace-1",
      parentSpanId: "request-span",
      input: { intent: "meta_or_out_of_scope" },
    }));
    expect([...requestContext.values()]).not.toContainEqual(expect.objectContaining({ createChildSpan: expect.any(Function) }));
  });
});
