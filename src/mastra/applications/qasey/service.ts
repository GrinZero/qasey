import { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
import {
  type AgentProgressReport,
  type QaseyRequestContext,
} from "../../../../packages/contracts/src/index.ts";
import { loadModelAttachments } from "../../../../packages/adapters/src/index.ts";
import {
  AgentProgressSession,
  completeCaseOperationAgainstPlan,
  EvidenceLedger,
  IncompleteOutcomeError,
} from "../../../../packages/domain/src/index.ts";
import type { EvidenceCompletionReceipt } from "../../../../packages/domain/src/index.ts";
import type { EvidenceLedgerStats } from "../../../../packages/domain/src/index.ts";
import type { MeterSphereCasePlan } from "../../../../packages/domain/src/index.ts";
import {
  initializeQaseyTraceRequestContext,
  startQaseyRequestSpan,
  recordQaseyEvent,
  traceQaseyOperation,
} from "./observability.ts";
import type { QaseyRequestSpan, QaseyTraceContext } from "./observability.ts";
import { config } from "../../runtime.ts";
import { meterSphereCaseWorkflowRunId, runMeterSphereCaseOperationWorkflow } from "../../workflows/metersphere-case-workflow.ts";
import { conversationScope } from "../../../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../../platform/context/schema.ts";

export interface QaseyResponse {
  text: string;
  runId: string;
  outcome: "success";
  finalization: "agent" | "receipt" | "workflow";
  completionReceipt?: EvidenceCompletionReceipt;
  evidenceStats: EvidenceLedgerStats;
  progress: AgentProgressReport[];
}

export interface QaseyAgentCompletionState {
  finishReason?: string;
  pendingToolCalls: number;
}

/** JSON-safe checkpoint emitted by the Skill-driven Agent phase. */
export interface QaseyAgentPhaseResult {
  context: QaseyRequestContext;
  runId: string;
  agentText: string;
  completionState: QaseyAgentCompletionState;
  casePlan?: MeterSphereCasePlan;
  completionReceipt?: EvidenceCompletionReceipt;
  evidenceStats: EvidenceLedgerStats;
  progress: AgentProgressReport[];
}

export interface QaseyFinalizationDecision extends QaseyAgentPhaseResult {
  finalization: QaseyResponse["finalization"];
}

export interface QaseyExecutionEvents {
  onPhase?: (event: { runId: string; phase: "agent" | "workflow" | "finalizing" }) => void | Promise<void>;
  onAgentProgress?: (event: AgentProgressReport & { runId: string }) => void | Promise<void>;
  onCasePlanCheckpoint?: (event: { runId: string; plan: MeterSphereCasePlan }) => void | Promise<void>;
  onCompletionCheckpoint?: (event: { runId: string; receipt: EvidenceCompletionReceipt }) => void | Promise<void>;
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
    disposition: "executed" | "deduplicated" | "cached_failure";
    error?: unknown;
  }) => void | Promise<void>;
}

export interface ExecuteQaseyOptions {
  runId?: string;
  abortSignal?: AbortSignal;
  events?: QaseyExecutionEvents;
  timeoutMs?: number;
  trace?: QaseyTraceContext;
  /** Parent workflow/channel tracing position for one continuous request trace. */
  tracingContext?: import("@mastra/core/observability").TracingContext;
  resumeCasePlan?: MeterSphereCasePlan;
  resumeReceipt?: EvidenceCompletionReceipt;
  caseOperationRunner?: (input: {
    mastra: Mastra;
    requestContext: RequestContext;
    plan: MeterSphereCasePlan;
    workflowRunId: string;
  }) => Promise<EvidenceCompletionReceipt>;
  /** Trusted context prepared by a native Workflow or channel ingress. */
  requestContext?: RequestContext<any>;
}

export async function executeQasey(mastra: Mastra, context: QaseyRequestContext, options: ExecuteQaseyOptions = {}): Promise<QaseyResponse> {
  const runId = options.runId ?? crypto.randomUUID();
  const requestContext = prepareQaseyRequestContext(context, options.requestContext);
  initializeQaseyTraceRequestContext(requestContext, context, options.trace);
  const requestTrace = startQaseyRequestSpan(
    mastra,
    requestContext,
    context,
    runId,
    options.trace,
    options.tracingContext,
  );
  let phase: QaseyAgentPhaseResult | undefined;
  try {
    phase = await runQaseyAgentPhase(mastra, context, {
      ...options,
      runId,
      requestContext,
      ...(requestTrace.tracingContext ? { tracingContext: requestTrace.tracingContext } : {}),
    });
    const decision = decideQaseyFinalization(phase);
    const response = await finalizeQaseyDecision(mastra, decision, {
      ...options,
      requestContext,
    });
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
  }
}

/**
 * Executes the Skill-driven Agent/tool loop, but performs no deterministic
 * write handoff or response finalization.
 */
export async function runQaseyAgentPhase(
  mastra: Mastra,
  context: QaseyRequestContext,
  options: ExecuteQaseyOptions & { runId: string; requestContext: RequestContext<any> },
): Promise<QaseyAgentPhaseResult> {
  const { runId, requestContext } = options;
  const evidenceLedger = new EvidenceLedger(runId, {
    ...(options.resumeCasePlan ? { casePlan: options.resumeCasePlan } : {}),
  });
  const resumeReceipt = validateQaseyCompletionReceipt(options.resumeCasePlan, options.resumeReceipt);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? config.QASEY_AGENT_TIMEOUT_MS);
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeoutSignal]) : timeoutSignal;
  if (options.resumeCasePlan) requestContext.set("case-plan", options.resumeCasePlan);
  const requestSpan = options.tracingContext?.currentSpan as QaseyRequestSpan | undefined;
  const agentProgress: AgentProgressReport[] = [];
  const progressSession = new AgentProgressSession(async report => {
    await options.events?.onAgentProgress?.({ runId, ...report });
    agentProgress.push(report);
  });
  requestContext.set("evidence-ledger", evidenceLedger);
  requestContext.set("agent-progress-session", progressSession);
  const files = await loadModelAttachments(context.attachments, config);
  const prompt = files.length === 0 ? context.chatInput : [{
    role: "user" as const,
    content: [{ type: "text" as const, text: context.chatInput }, ...files],
  }];
  const toolStarts = new Map<string, number[]>();
  let checkpointedPlanHash = options.resumeCasePlan?.planHash;
  let receiptFinalizationContinuationRequested = false;
  let planHandoffContinuationRequested = false;
  await options.events?.onPhase?.({ runId, phase: "agent" });
  const result = await mastra.getAgent("qasey-main").generate(prompt, {
    requestContext,
    ...(options.tracingContext ? { tracingContext: options.tracingContext } : {}),
    runId,
    maxSteps: 80,
    abortSignal,
    memory: {
      thread: requestContext.get(MASTRA_THREAD_ID_KEY),
      resource: requestContext.get(MASTRA_RESOURCE_ID_KEY),
    },
    toolCallConcurrency: 6,
    prepareStep: () => {
      if (resumeReceipt) return { activeTools: [], toolChoice: "none" as const };
      const receipt = evidenceLedger.completionReceipt();
      const planReady = evidenceLedger.casePlan();
      return receipt || planReady ? { activeTools: [], toolChoice: "none" as const } : undefined;
    },
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
          disposition: toolDisposition(output),
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
        const evidenceToolCallCount = toolCalls.filter(call => call.name !== "qasey_report_progress").length;
        const progress = evidenceLedger.finishIteration(evidenceToolCallCount);
        const casePlan = evidenceLedger.casePlan();
        if (casePlan && casePlan.planHash !== checkpointedPlanHash) {
          await options.events?.onCasePlanCheckpoint?.({ runId, plan: casePlan });
          checkpointedPlanHash = casePlan.planHash;
        }
        const checkpoint = casePlan
          ? validateQaseyCompletionReceipt(casePlan, evidenceLedger.completionReceipt())
          : evidenceLedger.completionReceipt();
        if (checkpoint) await options.events?.onCompletionCheckpoint?.({ runId, receipt: checkpoint });
        await options.events?.onIteration?.({
          runId,
          iteration,
          finishReason,
          isFinal,
          textChars: text.length,
          toolNames: toolCalls.map(call => call.name),
          toolCallIds: toolCalls.map(call => call.id),
          failedTools: toolResults.filter(result => result.error).map(result => result.name),
        });
        if (iteration >= 80) return { continue: false };
        const durableCompletion = checkpoint ?? resumeReceipt;
        if (
          durableCompletion
          && isFinal
          && finishReason === "tool-calls"
          && !receiptFinalizationContinuationRequested
        ) {
          receiptFinalizationContinuationRequested = true;
          return { continue: true };
        }
        if (
          casePlan
          && isFinal
          && finishReason === "tool-calls"
          && !planHandoffContinuationRequested
        ) {
          planHandoffContinuationRequested = true;
          return { continue: true };
        }
        if (iteration > 4 && toolCalls.length === 0 && text.trim().length === 0) return { continue: false, feedback: "Stop: no progress was made." };
        if (progress.shouldStop) {
          return {
            continue: false,
            feedback: `Stop: two consecutive tool iterations produced no new evidence or state transition.\n${evidenceLedger.manifestText()}`,
          };
        }
        if (!isFinal) {
          return {
            feedback: `${progress.shouldWarn ? "Warning: the last tool iteration produced no new evidence. Synthesize from acquired artifacts or finish with an explicit blocker; do not repeat the same source call.\n" : ""}${evidenceLedger.manifestText()}`,
          };
        }
        return undefined;
      },
    ),
  });
  abortSignal.throwIfAborted();
  const casePlan = evidenceLedger.casePlan();
  const completionReceipt = casePlan
    ? validateQaseyCompletionReceipt(casePlan, evidenceLedger.completionReceipt()) ?? resumeReceipt
    : evidenceLedger.completionReceipt() ?? resumeReceipt;
  return {
    context,
    runId,
    agentText: selectFinalText(result),
    completionState: inspectAgentCompletion(result),
    ...(casePlan ? { casePlan } : {}),
    ...(completionReceipt ? { completionReceipt } : {}),
    evidenceStats: evidenceLedger.stats(),
    progress: agentProgress,
  };
}

/** Pure completion validation used by both the native workflow and compatibility facade. */
export function decideQaseyFinalization(phase: QaseyAgentPhaseResult): QaseyFinalizationDecision {
  const receiptCompleted = Boolean(
    phase.completionReceipt
    && phase.completionState.finishReason === "tool-calls"
    && phase.completionState.pendingToolCalls === 0,
  );
  const planHandoffCompleted = Boolean(
    !phase.completionReceipt
    && phase.casePlan
    && phase.completionState.finishReason === "tool-calls"
    && phase.completionState.pendingToolCalls === 0,
  );
  if (!receiptCompleted && !planHandoffCompleted) assertCompletionState(phase.completionState);

  if (phase.casePlan && !phase.completionReceipt) {
    return { ...phase, finalization: "workflow" };
  }
  if (phase.completionReceipt) return { ...phase, finalization: "receipt" };
  if (!phase.agentText) throw new IncompleteOutcomeError("Agent stopped without a standalone final answer");
  return { ...phase, finalization: "agent" };
}

/** Executes the selected deterministic finalization path and assembles the public response. */
export async function finalizeQaseyDecision(
  mastra: Mastra,
  decision: QaseyFinalizationDecision,
  options: Pick<ExecuteQaseyOptions, "caseOperationRunner" | "events" | "requestContext" | "trace">,
): Promise<QaseyResponse> {
  const requestContext = prepareQaseyRequestContext(decision.context, options.requestContext);
  let completionReceipt = decision.completionReceipt;
  if (decision.finalization === "workflow") {
    const casePlan = decision.casePlan;
    if (!casePlan) throw new IncompleteOutcomeError("MeterSphere case operation did not produce a successful dry-run CasePlan");
    requestContext.set("case-plan", casePlan);
    requestContext.set("case-operation-phase", "execution");
    await options.events?.onPhase?.({ runId: decision.runId, phase: "workflow" });
    const workflowRunId = meterSphereCaseWorkflowRunId(options.trace?.jobId ?? decision.context.requestId, casePlan.planHash);
    const receipt = options.caseOperationRunner
      ? await options.caseOperationRunner({ mastra, requestContext, plan: casePlan, workflowRunId })
      : await runMeterSphereCaseOperationWorkflow(mastra, requestContext, casePlan, workflowRunId);
    completionReceipt = validateQaseyCompletionReceipt(casePlan, receipt);
    if (!completionReceipt) throw new IncompleteOutcomeError("MeterSphere case workflow returned an invalid completion receipt");
    await options.events?.onCompletionCheckpoint?.({ runId: decision.runId, receipt: completionReceipt });
  }
  return assembleQaseyResponse(decision, completionReceipt, options.events);
}

/** Builds the public response after a branch has completed its side effects. */
export async function assembleQaseyResponse(
  decision: QaseyFinalizationDecision,
  completionReceipt: EvidenceCompletionReceipt | undefined = decision.completionReceipt,
  events?: QaseyExecutionEvents,
): Promise<QaseyResponse> {
  let text: string;
  if (decision.finalization === "workflow" || decision.finalization === "receipt") {
    if (!completionReceipt) {
      throw new IncompleteOutcomeError(`${decision.finalization} finalization requires a verified completion receipt`);
    }
    text = completionReceiptText(completionReceipt);
  } else text = decision.agentText;
  if (!text) throw new IncompleteOutcomeError("Agent stopped without a standalone final answer");
  await events?.onPhase?.({ runId: decision.runId, phase: "finalizing" });
  return {
    text,
    runId: decision.runId,
    outcome: "success",
    finalization: decision.finalization,
    evidenceStats: decision.evidenceStats,
    progress: decision.progress,
    ...(completionReceipt ? { completionReceipt } : {}),
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

export function validateQaseyCompletionReceipt(
  plan: MeterSphereCasePlan | undefined,
  receipt: EvidenceCompletionReceipt | undefined,
): EvidenceCompletionReceipt | undefined {
  if (!plan || !receipt?.caseOperation) return undefined;
  if (receipt.verificationMode !== "separate_read_back"
    || receipt.caseOperation.verificationMode !== "separate_read_back") return undefined;
  if (receipt.casePlanHash !== plan.planHash) return undefined;
  const completeOperation = completeCaseOperationAgainstPlan(plan, receipt.caseOperation);
  return completeOperation ? { ...receipt, caseOperation: completeOperation } : undefined;
}

function toolDisposition(output: unknown): "executed" | "deduplicated" | "cached_failure" {
  if (!output || typeof output !== "object") return "executed";
  const status = (output as { status?: unknown }).status;
  if (status === "already_acquired") return "deduplicated";
  if (status === "failed") return "cached_failure";
  return "executed";
}

export function selectFinalText(result: { text?: string; steps?: Array<{ text?: string }> }): string {
  const steps = result.steps ?? [];
  if (steps.length > 0) return steps.at(-1)?.text?.trim() ?? "";
  return result.text?.trim() ?? "";
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

export function completionReceiptText(receipt: EvidenceCompletionReceipt): string {
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
