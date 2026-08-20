import type { Mastra } from "@mastra/core/mastra";
import { EntityType, SpanType } from "@mastra/core/observability";
import type { Span, TracingContext } from "@mastra/core/observability";
import type { RequestContext } from "@mastra/core/request-context";
import type { IntentRoute, QaseyRequestContext } from "../../../../packages/contracts/src/index.ts";

const QASEY_TRACE_ID_KEY = "qasey__traceId";
const QASEY_REQUEST_SPAN_ID_KEY = "qasey__requestSpanId";

export const QASEY_TRACE_REQUEST_CONTEXT_KEYS = [
  "requestId",
  "channel",
  "sessionId",
  "actorId",
  "intent",
  "relation",
  "writeTarget",
  "depth",
  "routerStatus",
  "jobId",
  "eventId",
  "attempt",
  "triggerSource",
  "triggerEventType",
  "triggerTraceId",
  "workerId",
] as const;

export interface QaseyTraceContext {
  jobId?: string;
  eventId?: string;
  attempt?: number;
  triggerSource?: string;
  triggerEventType?: string;
  triggerTraceId?: string;
  workerId?: string;
}

export type QaseyRequestSpan = Span<SpanType.GENERIC>;

export function initializeQaseyTraceRequestContext(
  requestContext: RequestContext,
  context: QaseyRequestContext,
  trace: QaseyTraceContext = {},
): void {
  requestContext.set("requestId", context.requestId);
  requestContext.set("channel", context.channel);
  requestContext.set("sessionId", context.sessionId);
  requestContext.set("actorId", context.actor.id);
  for (const [key, value] of Object.entries(trace)) {
    if (value !== undefined) requestContext.set(key, value);
  }
}

export function addRouteToTraceRequestContext(requestContext: RequestContext, route: IntentRoute): void {
  requestContext.set("intent", route.intent);
  requestContext.set("relation", route.relation);
  requestContext.set("writeTarget", route.writeTarget);
  requestContext.set("depth", route.depth);
  requestContext.set("routerStatus", route.routerStatus);
}

export function startQaseyRequestSpan(
  mastra: Mastra,
  requestContext: RequestContext,
  context: QaseyRequestContext,
  runId: string,
  trace: QaseyTraceContext = {},
  parentTracingContext?: TracingContext,
): { span?: QaseyRequestSpan; tracingContext?: TracingContext } {
  const instance = mastra.observability.getDefaultInstance();
  if (!instance) return {};
  const details = {
    type: SpanType.GENERIC,
    name: "qasey request",
    entityType: EntityType.AGENT,
    entityId: "qasey",
    entityName: "Qasey",
    input: {
      message: context.chatInput,
      channel: context.channel,
      sessionId: context.sessionId,
      actorId: context.actor.id,
      source: context.source,
      attachments: context.attachments.map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        source: attachment.source,
      })),
    },
    metadata: {
      runId,
      requestId: context.requestId,
      sessionId: context.sessionId,
      threadId: context.sessionId,
      resourceId: context.actor.id,
      actorId: context.actor.id,
      channel: context.channel,
      ...definedTraceMetadata(trace),
    },
    requestContext,
  } as const;
  const parentSpan = parentTracingContext?.currentSpan;
  const span = parentSpan && typeof parentSpan.createChildSpan === "function"
    ? parentSpan.createChildSpan(details)
    : instance.startSpan({ ...details, tags: ["qasey", `channel:${context.channel}`] });
  requestContext.set(QASEY_TRACE_ID_KEY, span.traceId);
  requestContext.set(QASEY_REQUEST_SPAN_ID_KEY, span.id);
  return { span, tracingContext: { currentSpan: span } };
}

/**
 * Dynamic Agent arguments in the installed Mastra version do not receive a
 * TracingContext. Correlate their spans through serializable trace/span ids
 * placed on RequestContext instead of storing a live Span there.
 */
export function startQaseyCorrelatedSpan(
  mastra: Mastra | undefined,
  requestContext: RequestContext<any>,
  name: string,
  input?: unknown,
): QaseyRequestSpan | undefined {
  const instance = mastra?.observability.getDefaultInstance();
  const traceId = requestContext.get(QASEY_TRACE_ID_KEY);
  const parentSpanId = requestContext.get(QASEY_REQUEST_SPAN_ID_KEY);
  if (!instance || typeof traceId !== "string" || typeof parentSpanId !== "string") return undefined;
  return instance.startSpan({
    type: SpanType.GENERIC,
    name,
    entityType: EntityType.AGENT,
    entityId: "qasey",
    entityName: "Qasey",
    ...(input === undefined ? {} : { input }),
    requestContext,
    traceId,
    parentSpanId,
  });
}

export async function traceQaseyOperation<T>(
  parent: QaseyRequestSpan | undefined,
  name: string,
  metadata: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const span = parent && typeof parent.createChildSpan === "function" ? parent.createChildSpan({
    type: SpanType.GENERIC,
    name,
    entityType: EntityType.AGENT,
    entityId: "qasey",
    entityName: "Qasey",
    metadata,
  }) : undefined;
  try {
    const result = await operation();
    span?.end();
    return result;
  } catch (error) {
    span?.error({
      error: error instanceof Error ? error : new Error(String(error)),
      endSpan: true,
    });
    throw error;
  }
}

export function recordQaseyEvent(
  parent: QaseyRequestSpan | undefined,
  name: string,
  metadata: Record<string, unknown>,
): void {
  if (!parent || typeof parent.createEventSpan !== "function") return;
  parent.createEventSpan({
    type: SpanType.GENERIC,
    name,
    entityType: EntityType.AGENT,
    entityId: "qasey",
    entityName: "Qasey",
    metadata,
  });
}

export function updateQaseyRequestSpanForRoute(span: QaseyRequestSpan | undefined, route: IntentRoute): void {
  span?.update({
    name: `qasey request: ${route.intent}`,
    metadata: {
      intent: route.intent,
      relation: route.relation,
      writeTarget: route.writeTarget,
      depth: route.depth,
      routerStatus: route.routerStatus,
    },
  });
}

function definedTraceMetadata(trace: QaseyTraceContext): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(trace).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
  );
}
