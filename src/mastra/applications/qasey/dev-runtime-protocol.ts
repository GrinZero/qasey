import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AgentProgressReportSchema,
  QaseyRequestContextSchema,
} from "../../../../packages/contracts/src/index.ts";
import type { QaseyAgentRuntimeEvent } from "./service.ts";
import { QaseyRemoteTraceContextSchema } from "./trace-carrier.ts";

export const DEV_RUNTIME_BINDING_TTL_MS = 8 * 60 * 60_000;
export const DEV_RUNTIME_PRESENCE_TTL_MS = 45_000;
export const DEV_RUNTIME_HEARTBEAT_MS = 15_000;
export const DEV_RUNTIME_RECONNECT_GRACE_MS = 20_000;
export const DEV_RUNTIME_ACCEPT_TIMEOUT_MS = 5_000;
export const DEV_RUNTIME_JOB_TTL_MS = 60 * 60_000;
export const DEV_RUNTIME_APPROVAL_TTL_MS = 10 * 60_000;

export const DevRuntimeIdSchema = z.string().regex(/^local-[A-Z2-9]{8}$/u);
export const DevRuntimeInstanceIdSchema = z.uuid();
export const DevRuntimeJobIdSchema = z.uuid();

export const DevRuntimeJobSchema = z.object({
  type: z.literal("job"),
  jobId: DevRuntimeJobIdSchema,
  runtimeId: DevRuntimeIdSchema,
  deadlineAt: z.iso.datetime(),
  context: QaseyRequestContextSchema,
  resourceId: z.string().min(1),
  threadId: z.string().min(1),
  trace: QaseyRemoteTraceContextSchema.optional(),
  delivery: z.object({
    workspaceId: z.string().min(1),
    installationId: z.string().min(1).optional(),
  }).strict(),
}).strict();

const SequencedEventSchema = z.object({
  sequence: z.number().int().positive(),
}).strict();

export const DevRuntimeAgentRuntimeEventSchema: z.ZodType<QaseyAgentRuntimeEvent> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step-start"),
    runId: z.string().min(1),
    step: z.number().int().nonnegative(),
    inputMessages: z.unknown().optional(),
  }).strict(),
  z.object({
    type: z.literal("tool-call"),
    runId: z.string().min(1),
    step: z.number().int().nonnegative(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown().optional(),
  }).strict(),
  z.object({
    type: z.literal("tool-result"),
    runId: z.string().min(1),
    step: z.number().int().nonnegative(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    isError: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("step-finish"),
    runId: z.string().min(1),
    step: z.number().int().nonnegative(),
    finishReason: z.string(),
    text: z.string().optional(),
    toolCalls: z.array(z.object({
      toolCallId: z.string().min(1),
      toolName: z.string().min(1),
      args: z.unknown().optional(),
    }).strict()),
  }).strict(),
]) as z.ZodType<QaseyAgentRuntimeEvent>;

export const DevRuntimeClientEventSchema = z.discriminatedUnion("type", [
  SequencedEventSchema.extend({ type: z.literal("accepted") }),
  SequencedEventSchema.extend({
    type: z.literal("phase"),
    runId: z.string().min(1),
    phase: z.enum(["agent", "workflow", "finalizing"]),
  }),
  SequencedEventSchema.extend({
    type: z.literal("progress"),
    runId: z.string().min(1),
    report: AgentProgressReportSchema,
  }),
  SequencedEventSchema.extend({
    type: z.literal("tool_started"),
    runId: z.string().min(1),
    toolName: z.string().min(1).max(256),
  }),
  SequencedEventSchema.extend({
    type: z.literal("agent_runtime_event"),
    event: DevRuntimeAgentRuntimeEventSchema,
  }),
  SequencedEventSchema.extend({
    type: z.literal("approval_requested"),
    approvalId: z.uuid(),
    toolName: z.string().min(1).max(256),
    argsSummary: z.string().max(1_200),
    argsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  SequencedEventSchema.extend({
    type: z.literal("completed"),
    result: z.unknown(),
  }),
  SequencedEventSchema.extend({
    type: z.literal("failed"),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
  }),
  SequencedEventSchema.extend({ type: z.literal("cancelled") }),
]);

export const DevRuntimeServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connected"), runtimeId: DevRuntimeIdSchema }).strict(),
  DevRuntimeJobSchema,
  z.object({
    type: z.literal("approval_decision"),
    approvalId: z.uuid(),
    decision: z.enum(["approved", "declined"]),
  }).strict(),
  z.object({
    type: z.literal("cancel"),
    jobId: DevRuntimeJobIdSchema,
    reason: z.string().min(1).max(500),
  }).strict(),
]);

export const DevRuntimeApprovalCallbackSchema = z.object({
  type: z.literal("action"),
  actionId: z.enum(["qasey_local_approve", "qasey_local_decline"]),
  user: z.object({ id: z.string().min(1), name: z.string().optional() }),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
}).passthrough();

export type DevRuntimeJob = z.infer<typeof DevRuntimeJobSchema>;
export type DevRuntimeClientEvent = z.infer<typeof DevRuntimeClientEventSchema>;
export type DevRuntimeServerEvent = z.infer<typeof DevRuntimeServerEventSchema>;

export function runtimeJobTopic(runtimeId: string): string {
  return `qasey:dev-runtime:${runtimeId}:jobs`;
}

export function jobEventTopic(jobId: string): string {
  return `qasey:dev-job:${jobId}:events`;
}

export function secureTokenMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || undefined;
}

export function hashCapability(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
