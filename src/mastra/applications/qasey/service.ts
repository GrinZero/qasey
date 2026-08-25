import { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
import type { DurableAgentStreamResult } from "@mastra/core/agent/durable";
import type { ChunkType } from "@mastra/core/stream";
import { z } from "zod";
import {
  AgentProgressReportSchema,
  type AgentProgressReport,
  type QaseyRequestContext,
} from "../../../../packages/contracts/src/index.ts";
import { loadModelAttachments } from "../../../../packages/adapters/src/index.ts";
import {
  AgentProgressSession,
  IncompleteOutcomeError,
} from "../../../../packages/domain/src/index.ts";
import type { MeterSphereCaseCompletionReceipt, MeterSphereCasePlan } from "../../../../packages/domain/src/index.ts";
import {
  initializeQaseyTraceRequestContext,
  startQaseyRequestSpan,
  recordQaseyEvent,
  traceQaseyOperation,
} from "./observability.ts";
import type { QaseyRequestSpan, QaseyTraceContext } from "./observability.ts";
import type { QaseyRemoteTraceContext } from "./trace-carrier.ts";
import { config } from "../../runtime.ts";
import { MeterSphereCaseCompletionReceiptSchema } from "../../workflows/metersphere-case-workflow.ts";
import { QASEY_AGENT_SAFETY_MAX_STEPS } from "../../agents/qasey-main/processors.ts";
import { conversationScope } from "../../../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../../platform/context/schema.ts";

export interface QaseyResponse {
  text: string;
  runId: string;
  outcome: "success";
  finalization: "agent" | "workflow";
  completionReceipt?: MeterSphereCaseCompletionReceipt;
  progress: AgentProgressReport[];
}

export const QaseyResponseSchema = z.object({
  text: z.string().min(1),
  runId: z.string().min(1),
  outcome: z.literal("success"),
  finalization: z.enum(["agent", "workflow"]),
  completionReceipt: MeterSphereCaseCompletionReceiptSchema.optional(),
  progress: z.array(AgentProgressReportSchema),
});

export interface QaseyAgentCompletionState {
  finishReason?: string;
  pendingToolCalls: number;
}

/** Result of the direct Skill-driven Durable Agent phase. */
export interface QaseyAgentPhaseResult {
  context: QaseyRequestContext;
  runId: string;
  agentText: string;
  completionState: QaseyAgentCompletionState;
  progress: AgentProgressReport[];
}

export type QaseyAgentRuntimeEvent =
  | {
    type: "step-start";
    runId: string;
    step: number;
    inputMessages?: unknown;
  }
  | {
    type: "tool-call";
    runId: string;
    step: number;
    toolCallId: string;
    toolName: string;
    args?: unknown;
  }
  | {
    type: "tool-result";
    runId: string;
    step: number;
    toolCallId: string;
    toolName: string;
    args?: unknown;
    result?: unknown;
    isError: boolean;
  }
  | {
    type: "step-finish";
    runId: string;
    step: number;
    finishReason: string;
    text?: string;
    toolCalls: Array<{ toolCallId: string; toolName: string; args?: unknown }>;
  };

export interface QaseyExecutionEvents {
  onPhase?: (event: { runId: string; phase: "agent" | "workflow" | "finalizing" }) => void | Promise<void>;
  onAgentRuntimeEvent?: (event: QaseyAgentRuntimeEvent) => void | Promise<void>;
  onAgentProgress?: (event: AgentProgressReport & { runId: string }) => void | Promise<void>;
  onCasePlanCheckpoint?: (event: { runId: string; plan: MeterSphereCasePlan }) => void | Promise<void>;
  onCompletionCheckpoint?: (event: { runId: string; receipt: MeterSphereCaseCompletionReceipt }) => void | Promise<void>;
  onIteration?: (event: {
    runId: string;
    iteration: number;
    finishReason: string;
    isFinal: boolean;
    textChars: number;
    toolNames: string[];
    toolCallIds: string[];
    failedTools: string[];
  }) => void | Promise<void>;
  onToolStart?: (event: { runId: string; toolName: string; inputKeys: string[] }) => void | Promise<void>;
  onToolEnd?: (event: {
    runId: string;
    toolName: string;
    durationMs?: number;
    outputType: string;
    disposition: "executed";
    error?: unknown;
  }) => void | Promise<void>;
}

export interface ExecuteQaseyOptions {
  runId?: string;
  abortSignal?: AbortSignal;
  events?: QaseyExecutionEvents;
  timeoutMs?: number;
  trace?: QaseyTraceContext;
  remoteParent?: QaseyRemoteTraceContext;
  /** Parent workflow/channel tracing position for one continuous request trace. */
  tracingContext?: import("@mastra/core/observability").TracingContext;
  /** Trusted context prepared by a native Workflow or channel ingress. */
  requestContext?: RequestContext<any>;
}

type QaseyAgentStreamResult = {
  fullStream: AsyncIterable<ChunkType>;
  output?: Pick<DurableAgentStreamResult["output"], "getFullOutput">;
  getFullOutput?: () => Promise<unknown>;
  cleanup?: () => void;
};

export async function executeQasey(mastra: Mastra, context: QaseyRequestContext, options: ExecuteQaseyOptions = {}): Promise<QaseyResponse> {
  const runId = options.runId ?? crypto.randomUUID();
  const requestContext = prepareQaseyRequestContext(context, options.requestContext);
  requestContext.delete("case-plan");
  requestContext.delete("case-completion-receipt");
  requestContext.set("qasey-agent-run-id", runId);
  if (options.events) requestContext.set("qasey-execution-events", options.events);
  initializeQaseyTraceRequestContext(requestContext, context, options.trace);
  const requestTrace = startQaseyRequestSpan(
    mastra,
    requestContext,
    context,
    runId,
    options.trace,
    options.tracingContext,
    options.remoteParent,
  );
  try {
    const phase = await runQaseyAgentPhase(mastra, context, {
      ...options,
      runId,
      requestContext,
      ...(requestTrace.tracingContext ? { tracingContext: requestTrace.tracingContext } : {}),
    });
    assertCompletionState(phase.completionState);
    const storedReceipt = requestContext.get("case-completion-receipt");
    const completionReceipt = storedReceipt === undefined
      ? undefined
      : MeterSphereCaseCompletionReceiptSchema.parse(storedReceipt) as MeterSphereCaseCompletionReceipt;
    const text = completionReceipt ? completionReceiptText(completionReceipt) : phase.agentText;
    if (!text) throw new IncompleteOutcomeError("Agent stopped without a standalone final answer");
    await options.events?.onPhase?.({ runId, phase: "finalizing" });
    const response: QaseyResponse = {
      text,
      runId,
      outcome: "success",
      finalization: completionReceipt ? "workflow" : "agent",
      progress: phase.progress,
      ...(completionReceipt ? { completionReceipt } : {}),
    };
    requestTrace.span?.end({
      output: response,
      metadata: {
        outcome: response.outcome,
        finalization: response.finalization,
      },
    });
    return response;
  } catch (error) {
    requestTrace.span?.error({
      error: error instanceof Error ? error : new Error(String(error)),
      endSpan: true,
      metadata: {
        outcome: "error",
      },
    });
    throw error;
  } finally {
    requestContext.delete("qasey-execution-events");
    requestContext.delete("qasey-agent-run-id");
    requestContext.delete("agent-progress-session");
    requestContext.delete("case-plan");
    requestContext.delete("case-completion-receipt");
    requestContext.delete("case-operation-phase");
    requestContext.delete("externalWriteIdempotencyKey");
  }
}

/**
 * Executes the Skill-driven Durable Agent/tool loop. Trusted domain tools may
 * run nested durable workflows during this phase.
 */
export async function runQaseyAgentPhase(
  mastra: Mastra,
  context: QaseyRequestContext,
  options: ExecuteQaseyOptions & { runId: string; requestContext: RequestContext<any> },
): Promise<QaseyAgentPhaseResult> {
  const { runId, requestContext } = options;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? config.QASEY_AGENT_TIMEOUT_MS);
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeoutSignal]) : timeoutSignal;
  const requestSpan = options.tracingContext?.currentSpan as QaseyRequestSpan | undefined;
  const agentProgress: AgentProgressReport[] = [];
  const progressSession = new AgentProgressSession(async report => {
    await options.events?.onAgentProgress?.({ runId, ...report });
    agentProgress.push(report);
  });
  requestContext.set("agent-progress-session", progressSession);
  const files = await loadModelAttachments(context.attachments, config);
  const prompt = files.length === 0 ? context.chatInput : [{
    role: "user" as const,
    content: [{ type: "text" as const, text: context.chatInput }, ...files],
  }];
  const toolStarts = new Map<string, number[]>();
  let finishSnapshot: AgentFinishSnapshot | undefined;
  await options.events?.onPhase?.({ runId, phase: "agent" });
  const stream = await mastra.getAgent("qasey-main").stream(prompt, {
    requestContext,
    ...(options.tracingContext ? { tracingContext: options.tracingContext } : {}),
    runId,
    maxSteps: QASEY_AGENT_SAFETY_MAX_STEPS,
    abortSignal,
    memory: {
      thread: requestContext.get(MASTRA_THREAD_ID_KEY),
      resource: requestContext.get(MASTRA_RESOURCE_ID_KEY),
    },
    toolCallConcurrency: 6,
    hooks: {
      beforeToolCall: async ({ toolName, input }) => {
        const starts = toolStarts.get(toolName) ?? [];
        starts.push(Date.now());
        toolStarts.set(toolName, starts);
        await options.events?.onToolStart?.({
          runId,
          toolName,
          inputKeys: input && typeof input === "object" ? Object.keys(input as Record<string, unknown>).slice(0, 30) : [],
        });
      },
      afterToolCall: async ({ toolName, output, error }) => {
        const starts = toolStarts.get(toolName);
        const startedAt = starts?.shift();
        if (starts?.length === 0) toolStarts.delete(toolName);
        await options.events?.onToolEnd?.({
          runId,
          toolName,
          ...(startedAt ? { durationMs: Date.now() - startedAt } : {}),
          outputType: output === null ? "null" : Array.isArray(output) ? "array" : typeof output,
          disposition: "executed",
          ...(error ? { error } : {}),
        });
      },
    },
    onStepFinish: ({ finishReason, toolCalls, toolResults, text }) => {
      recordQaseyEvent(requestSpan, "qasey agent step finished", {
        finishReason,
        textChars: text.length,
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
      });
    },
    onFinish: ({ finishReason, text, steps }) => {
      finishSnapshot = {
        ...(finishReason ? { finishReason } : {}),
        text,
        steps: steps as unknown as Array<Record<string, unknown> & { text?: string }>,
      };
      recordQaseyEvent(requestSpan, "qasey agent generation finished", {
        finishReason,
        textChars: text.length,
        stepCount: steps.length,
      });
    },
    onIterationComplete: async ({ iteration, toolCalls, toolResults, text, finishReason, isFinal }) => traceQaseyOperation(
      requestSpan,
      "qasey agent iteration callback",
      { iteration, finishReason, isFinal, toolCallCount: toolCalls.length },
      async () => {
        await options.events?.onIteration?.({
        runId,
        iteration,
        finishReason,
        isFinal,
        textChars: text.length,
        toolNames: toolCalls.map(call => call.name),
        toolCallIds: toolCalls.map(call => call.id),
        failedTools: toolResults.filter(toolResult => toolResult.error).map(toolResult => toolResult.name),
        });
      },
    ),
  }) as unknown as QaseyAgentStreamResult;
  const getFullOutput = stream.output?.getFullOutput.bind(stream.output)
    ?? stream.getFullOutput?.bind(stream);
  if (!getFullOutput) throw new TypeError("Agent stream did not expose getFullOutput");
  let result: unknown;
  try {
    let step = 0;
    let stepText = "";
    for await (const chunk of stream.fullStream) {
      if (chunk.type === "step-start") stepText = "";
      if (chunk.type === "text-delta") stepText = `${stepText}${chunk.payload.text}`.slice(0, 2_000);
      let event = agentRuntimeEventFromChunk(runId, step, chunk);
      if (event?.type === "step-start") step = event.step;
      if (event?.type === "step-finish" && !event.text && stepText.trim()) event = { ...event, text: stepText };
      if (event) await options.events?.onAgentRuntimeEvent?.(event);
      if (event?.type === "step-finish") stepText = "";
    }
    result = await getFullOutput();
  } finally {
    stream.cleanup?.();
  }
  abortSignal.throwIfAborted();
  const completedResult = restoreProcessedAgentOutput(result, finishSnapshot);
  return {
    context,
    runId,
    agentText: selectFinalText(completedResult as { text?: string; steps?: Array<{ text?: string }> }),
    completionState: inspectAgentCompletion(completedResult),
    progress: agentProgress,
  };
}

export function prepareQaseyRequestContext(
  context: QaseyRequestContext,
  existing?: RequestContext<any>,
): RequestContext<any> {
  const requestContext = existing ?? new RequestContext();
  const tenantId = context.actor.tenantId
    ?? (config.NODE_ENV === "production" ? undefined : "local");
  if (!tenantId) throw new Error("A trusted tenant id is required");
  const trustedIdentity = requestContext.get("identity") as { userId?: unknown; tenantId?: unknown } | undefined;
  if (trustedIdentity && (trustedIdentity.userId !== context.actor.id || trustedIdentity.tenantId !== tenantId)) {
    throw new Error("Qasey request actor does not match the trusted ingress identity");
  }
  requestContext.set("applicationId", "qasey");
  requestContext.set("tenantId", tenantId);
  requestContext.set("userId", context.actor.id);
  if (!trustedIdentity) {
    requestContext.set("identity", { userId: context.actor.id, tenantId, roles: ["user"], service: context.channel !== "api" });
  }
  const scope = conversationScope({
    applicationId: "qasey", tenantId, userId: context.actor.id,
    conversationId: context.sessionId, externalThreadId: context.sessionId,
    kind: context.channel === "api" ? "private" : "shared",
  });
  requestContext.set("requestId", context.requestId);
  requestContext.set("channel", context.channel);
  requestContext.set("ingressSource", context.channel);
  requestContext.set("sessionId", context.sessionId);
  if (!requestContext.has(MASTRA_RESOURCE_ID_KEY)) requestContext.set(MASTRA_RESOURCE_ID_KEY, scope.resourceId);
  if (!requestContext.has(MASTRA_THREAD_ID_KEY)) requestContext.set(MASTRA_THREAD_ID_KEY, scope.threadId);
  requestContext.set("qasey-context", context);
  return requestContext;
}

export function selectFinalText(result: { text?: string; steps?: Array<{ text?: string }> }): string {
  const steps = result.steps ?? [];
  if (steps.length > 0) return steps.at(-1)?.text?.trim() ?? "";
  return result.text?.trim() ?? "";
}

interface AgentFinishSnapshot {
  text: string;
  finishReason?: string;
  steps: Array<Record<string, unknown> & { text?: string }>;
}

export function agentRuntimeEventFromChunk(
  runId: string,
  currentStep: number,
  chunk: ChunkType,
): QaseyAgentRuntimeEvent | undefined {
  if (chunk.type === "step-start") {
    return {
      type: "step-start",
      runId,
      step: currentStep + 1,
      ...(chunk.payload.inputMessages ? { inputMessages: chunk.payload.inputMessages } : {}),
    };
  }
  if (chunk.type === "tool-call") {
    return {
      type: "tool-call",
      runId,
      step: currentStep,
      toolCallId: chunk.payload.toolCallId,
      toolName: chunk.payload.toolName,
      ...(chunk.payload.args !== undefined ? { args: chunk.payload.args } : {}),
    };
  }
  if (chunk.type === "tool-result") {
    return {
      type: "tool-result",
      runId,
      step: currentStep,
      toolCallId: chunk.payload.toolCallId,
      toolName: chunk.payload.toolName,
      ...(chunk.payload.args !== undefined ? { args: chunk.payload.args } : {}),
      result: chunk.payload.result,
      isError: chunk.payload.isError === true,
    };
  }
  if (chunk.type === "tool-error") {
    return {
      type: "tool-result",
      runId,
      step: currentStep,
      toolCallId: chunk.payload.toolCallId,
      toolName: chunk.payload.toolName,
      ...(chunk.payload.args !== undefined ? { args: chunk.payload.args } : {}),
      result: chunk.payload.error,
      isError: true,
    };
  }
  if (chunk.type === "step-finish") {
    return {
      type: "step-finish",
      runId,
      step: currentStep,
      finishReason: chunk.payload.stepResult.reason,
      ...(chunk.payload.output.text ? { text: chunk.payload.output.text } : {}),
      toolCalls: (chunk.payload.output.toolCalls ?? []).map(call => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...(call.input !== undefined ? { args: call.input } : {}),
      })),
    };
  }
  return undefined;
}

/**
 * BatchPartsProcessor reduces Redis/pubsub writes for durable streams. Mastra
 * 1.59 can still return an empty FullOutput after processing those chunks,
 * while its native onFinish callback contains the complete text and steps.
 * Use that terminal snapshot for aggregate fields; the callback is
 * observational and its return value never controls the durable loop.
 */
export function restoreProcessedAgentOutput(result: unknown, finish?: AgentFinishSnapshot): unknown {
  if (!isRecord(result) || !finish) return result;
  const output = { ...result };
  if (finish.text.trim()) output.text = finish.text;
  if (finish.steps.length > 0) output.steps = finish.steps;
  if (finish.finishReason) output.finishReason = finish.finishReason;
  return output;
}

export function assertNormalCompletion(result: unknown): void {
  assertCompletionState(inspectAgentCompletion(result));
}

function assertCompletionState(state: QaseyAgentCompletionState): void {
  if (state.pendingToolCalls > 0) throw new IncompleteOutcomeError(`Agent stopped with ${state.pendingToolCalls} unfinished tool call(s)`);
  if (state.finishReason && state.finishReason !== "stop") {
    throw new IncompleteOutcomeError(`Agent did not finish normally (finishReason=${state.finishReason})`);
  }
}

export function completionReceiptText(receipt: MeterSphereCaseCompletionReceipt): string {
  const operation = receipt.caseOperation;
  if (!operation) return "MeterSphere 用例操作已完成，写入及回查凭证已保存。";
  const verification = operation.verificationMode === "separate_read_back" ? "独立回查" : "写入回查";
  return [
    `MeterSphere 用例操作已完成：共处理 ${operation.itemCount} 条，新建 ${operation.createdCount} 条、更新 ${operation.updatedCount} 条，${verification}通过 ${operation.verifiedCount}/${operation.itemCount}。`,
    operation.modulePath ? `目标模块：\`${operation.modulePath}\`。` : "",
  ].filter(Boolean).join("\n");
}

function inspectAgentCompletion(result: unknown): { finishReason?: string; pendingToolCalls: number } {
  if (!result || typeof result !== "object") throw new IncompleteOutcomeError("Agent returned an invalid result");
  const output = result as Record<string, unknown>;
  const steps = Array.isArray(output.steps) ? output.steps.filter(isRecord) : [];
  const lastStep = steps.at(-1);
  const finishReason = stringField(lastStep?.finishReason) ?? stringField(output.finishReason);
  const resultIds = new Set(steps.flatMap(step => arrayField(step.toolResults)).map(toolCallId).filter(Boolean));
  const pending = steps.flatMap(step => arrayField(step.toolCalls)).filter(call => {
    const id = toolCallId(call);
    return id && !resultIds.has(id);
  });
  return { ...(finishReason ? { finishReason } : {}), pendingToolCalls: pending.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function arrayField(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolCallId(value: Record<string, unknown>): string | undefined {
  const payload = isRecord(value.payload) ? value.payload : undefined;
  return stringField(value.id) ?? stringField(value.toolCallId) ?? stringField(payload?.toolCallId);
}
