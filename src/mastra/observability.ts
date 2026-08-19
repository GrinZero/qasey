import type { Mastra } from "@mastra/core/mastra";
import { EntityType, SpanType } from "@mastra/core/observability";
import type { Span, TracingContext } from "@mastra/core/observability";
import type { RequestContext } from "@mastra/core/request-context";
import type { IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";

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
): { span?: QaseyRequestSpan; tracingContext?: TracingContext } {
  const instance = mastra.observability.getDefaultInstance();
  if (!instance) return {};
  const span = instance.startSpan({
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
    tags: ["qasey", `channel:${context.channel}`],
  });
  return { span, tracingContext: { currentSpan: span } };
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
