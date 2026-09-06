import type { Mastra } from "@mastra/core/mastra";
import { TracingEventType } from "@mastra/core/observability";
import { describe, expect, it, vi } from "vitest";
import type { CodeTaskEvent } from "../../packages/contracts/src/index.ts";
import {
  codeTaskExecutionTelemetry,
  decodeCodeTaskTracingEvent,
  forwardCodeTaskTracingEvents,
} from "../../src/mastra/workflows/code-task-tracing.ts";

const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16) };

describe("CodeTask tracing bridge", () => {
  it("creates a W3C carrier for the current E2E operation", () => {
    const mastra = { observability: { getDefaultInstance: () => ({}) } } as unknown as Mastra;

    expect(codeTaskExecutionTelemetry(mastra, parent)?.traceContext).toEqual({
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      traceparent: `00-${parent.traceId}-${parent.spanId}-01`,
    });
  });

  it("grafts the worker Agent root beneath the E2E operation", () => {
    const decoded = decodeCodeTaskTracingEvent(traceEvent(), parent);

    expect(decoded?.exportedSpan).toMatchObject({
      traceId: parent.traceId,
      id: "c".repeat(16),
      parentSpanId: parent.spanId,
      isRootSpan: false,
    });
    expect(decoded?.exportedSpan.startTime).toBeInstanceOf(Date);
    expect(decoded?.exportedSpan.endTime).toBeInstanceOf(Date);
    expect(decoded?.exportedSpan.externalParentSpanId).toBeUndefined();
    expect(decoded?.exportedSpan.tags).toBeUndefined();
  });

  it("drops cross-trace events and forwards valid events through the main observability bus", async () => {
    const receive = vi.fn();
    const mastra = {
      observability: { getDefaultInstance: () => ({ __receiveExternalEvent: receive, getExporters: () => [] }) },
    } as unknown as Mastra;
    const valid = codeTaskEvent(traceEvent());
    const invalid = codeTaskEvent({
      ...traceEvent(),
      exportedSpan: { ...traceEvent().exportedSpan, traceId: "d".repeat(32) },
    });

    await forwardCodeTaskTracingEvents(mastra, parent, [valid, invalid]);

    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ type: TracingEventType.SPAN_ENDED }));
  });
});

function traceEvent() {
  return {
    type: TracingEventType.SPAN_ENDED,
    exportedSpan: {
      id: "c".repeat(16),
      traceId: parent.traceId,
      name: "agent run",
      type: "agent_run",
      startTime: "2026-09-05T00:00:00.000Z",
      endTime: "2026-09-05T00:00:01.000Z",
      isEvent: false,
      isRootSpan: true,
      externalParentSpanId: parent.spanId,
      tags: ["worker-root"],
    },
  };
}

function codeTaskEvent(mastraTraceEvent: unknown): CodeTaskEvent {
  return {
    cursor: "1",
    taskId: "run-1:author:0",
    at: "2026-09-05T00:00:01.000Z",
    type: "agent.trace.span_ended",
    message: "Agent span ended",
    metadata: { mastraTraceEvent },
  };
}
