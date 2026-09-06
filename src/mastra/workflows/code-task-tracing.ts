import type { Mastra } from "@mastra/core/mastra";
import { TracingEventType } from "@mastra/core/observability";
import type { TracingEvent } from "@mastra/core/observability";
import type { CodeTaskEvent } from "../../../packages/contracts/src/index.ts";
import type { CodeTaskExecutionTelemetry } from "../../../packages/e2e/src/coordinator.ts";

export interface CodeTaskTraceParent {
  traceId: string;
  spanId: string;
}

export function codeTaskExecutionTelemetry(
  mastra: Mastra | undefined,
  parent: CodeTaskTraceParent | undefined,
): CodeTaskExecutionTelemetry | undefined {
  if (!mastra || !parent || !isTraceId(parent.traceId) || !isSpanId(parent.spanId)) return undefined;
  return {
    traceContext: {
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      traceparent: `00-${parent.traceId}-${parent.spanId}-01`,
    },
    onEvents: events => forwardCodeTaskTracingEvents(mastra, parent, events),
  };
}

export async function forwardCodeTaskTracingEvents(
  mastra: Mastra,
  parent: CodeTaskTraceParent,
  events: CodeTaskEvent[],
): Promise<void> {
  const instance = mastra.observability?.getDefaultInstance();
  if (!instance) return;
  for (const event of events) {
    const tracingEvent = decodeCodeTaskTracingEvent(event.metadata.mastraTraceEvent, parent);
    if (!tracingEvent) continue;
    const externalReceiver = instance as typeof instance & {
      __receiveExternalEvent?: (event: TracingEvent) => void;
    };
    if (externalReceiver.__receiveExternalEvent) {
      externalReceiver.__receiveExternalEvent(tracingEvent);
      continue;
    }
    await Promise.all(instance.getExporters().map(exporter => exporter.exportTracingEvent(tracingEvent)));
  }
}

export function decodeCodeTaskTracingEvent(
  value: unknown,
  parent: CodeTaskTraceParent,
): TracingEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Object.values(TracingEventType).includes(candidate.type as TracingEventType)) return undefined;
  if (!candidate.exportedSpan || typeof candidate.exportedSpan !== "object" || Array.isArray(candidate.exportedSpan)) return undefined;
  const span = { ...(candidate.exportedSpan as Record<string, unknown>) };
  if (!isSpanId(span.id) || span.traceId !== parent.traceId || typeof span.name !== "string" || typeof span.type !== "string") return undefined;
  const startTime = dateValue(span.startTime);
  if (!startTime) return undefined;
  span.startTime = startTime;
  if (span.endTime !== undefined) {
    const endTime = dateValue(span.endTime);
    if (!endTime) return undefined;
    span.endTime = endTime;
  }
  if (!span.parentSpanId && (span.isRootSpan === true || span.externalParentSpanId === parent.spanId)) {
    span.parentSpanId = parent.spanId;
    span.externalParentSpanId = undefined;
    span.isRootSpan = false;
    span.tags = undefined;
  }
  return { type: candidate.type, exportedSpan: span } as unknown as TracingEvent;
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isTraceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/iu.test(value);
}

function isSpanId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}$/iu.test(value);
}
