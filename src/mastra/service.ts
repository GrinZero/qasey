import { RequestContext } from "@mastra/core/request-context";
import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import type { AgentProgressReport, IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { loadModelAttachments } from "../../packages/adapters/src/index.ts";
import { AgentProgressSession, completeCaseOperationAgainstPlan, EvidenceLedger, IncompleteOutcomeError } from "../../packages/domain/src/index.ts";
import type { EvidenceCompletionReceipt } from "../../packages/domain/src/index.ts";
import type { EvidenceLedgerStats } from "../../packages/domain/src/index.ts";
import type { MeterSphereCasePlan } from "../../packages/domain/src/index.ts";
import { routeIntent } from "./intent-agent.ts";
import {
  addRouteToTraceRequestContext,
  initializeQaseyTraceRequestContext,
  startQaseyRequestSpan,
  updateQaseyRequestSpanForRoute,
} from "./observability.ts";
import type { QaseyTraceContext } from "./observability.ts";
import { config } from "./runtime.ts";
import { meterSphereCaseWorkflowRunId, runMeterSphereCaseOperationWorkflow } from "./metersphere-case-workflow.ts";
import { intentRouterAgent } from "./intent-agent.ts";
import { conversationScope } from "../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../platform/context/schema.ts";

export interface QaseyResponse {
  text: string;
  route: IntentRoute;
  runId: string;
  outcome: "success";
  finalization: "agent" | "receipt" | "workflow";
  completionReceipt?: EvidenceCompletionReceipt;
  evidenceStats: EvidenceLedgerStats;
  progress: AgentProgressReport[];
}

export interface QaseyExecutionEvents {
  onPhase?: (event: { runId: string; phase: "routing" | "agent" | "workflow" | "finalizing" }) => void | Promise<void>;
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
  intentAgent?: Agent<any, any, any, any, any>;
  abortSignal?: AbortSignal;
  events?: QaseyExecutionEvents;
  timeoutMs?: number;
  trace?: QaseyTraceContext;
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
  /** Pre-classified route produced by the qasey-task Workflow. */
  route?: IntentRoute;
}

export async function executeQasey(mastra: Mastra, context: QaseyRequestContext, options: ExecuteQaseyOptions = {}): Promise<QaseyResponse> {
  const runId = options.runId ?? crypto.randomUUID();
  const evidenceLedger = new EvidenceLedger(runId, {
    ...(options.resumeCasePlan ? { casePlan: options.resumeCasePlan } : {}),
  });
  const resumeReceipt = validCaseCompletionReceipt(options.resumeCasePlan, options.resumeReceipt);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? config.QASEY_AGENT_TIMEOUT_MS);
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeoutSignal]) : timeoutSignal;
  const requestContext = prepareQaseyRequestContext(context, options.requestContext);
  if (options.resumeCasePlan) requestContext.set("case-plan", options.resumeCasePlan);
  initializeQaseyTraceRequestContext(requestContext, context, options.trace);
  const requestTrace = startQaseyRequestSpan(mastra, requestContext, context, runId, options.trace);
  let route: IntentRoute | undefined;
  try {
    if (!options.route) await options.events?.onPhase?.({ runId, phase: "routing" });
    route = options.route ?? await routeIntent(context, [], abortSignal, options.intentAgent ?? intentRouterAgent, {
      requestContext,
      ...(requestTrace.tracingContext ? { tracingContext: requestTrace.tracingContext } : {}),
    });
    requestContext.set("intent-route", route);
    const routedCaseIntent = isMeterSphereCaseIntent(route.intent);
    if (routedCaseIntent) requestContext.set("case-operation-phase", "planning");
    addRouteToTraceRequestContext(requestContext, route);
    updateQaseyRequestSpanForRoute(requestTrace.span, route);
    const agentProgress: AgentProgressReport[] = [];
    const progressSession = new AgentProgressSession(route, async report => {
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
      ...(requestTrace.tracingContext ? { tracingContext: requestTrace.tracingContext } : {}),
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
        const planReady = routedCaseIntent && evidenceLedger.casePlan();
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
      onIterationComplete: async ({ iteration, toolCalls, toolResults, text, finishReason, isFinal }) => {
        const evidenceToolCallCount = toolCalls.filter(call => call.name !== "qasey_report_progress").length;
        const progress = evidenceLedger.finishIteration(evidenceToolCallCount);
        const casePlan = evidenceLedger.casePlan();
        if (casePlan && casePlan.planHash !== checkpointedPlanHash) {
          await options.events?.onCasePlanCheckpoint?.({ runId, plan: casePlan });
          checkpointedPlanHash = casePlan.planHash;
        }
        const checkpoint = routedCaseIntent
          ? validCaseCompletionReceipt(casePlan, evidenceLedger.completionReceipt())
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
          && routedCaseIntent
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
    });
    abortSignal.throwIfAborted();
    let completionReceipt = routedCaseIntent
      ? validCaseCompletionReceipt(evidenceLedger.casePlan(), evidenceLedger.completionReceipt()) ?? resumeReceipt
      : evidenceLedger.completionReceipt() ?? resumeReceipt;
    const completionState = inspectAgentCompletion(result);
    const caseIntent = routedCaseIntent;
    const receiptCompleted = Boolean(
      completionReceipt
      && caseIntent
      && completionState.finishReason === "tool-calls"
      && completionState.pendingToolCalls === 0,
    );
    const casePlan = evidenceLedger.casePlan();
    const planHandoffCompleted = Boolean(
      caseIntent
      && !completionReceipt
      && casePlan
      && completionState.finishReason === "tool-calls"
      && completionState.pendingToolCalls === 0,
    );
    if (!receiptCompleted && !planHandoffCompleted) assertNormalCompletion(result);

    let finalization: QaseyResponse["finalization"];
    let text: string;
    if (caseIntent && !completionReceipt) {
      if (!casePlan) {
        throw new IncompleteOutcomeError("MeterSphere case operation did not produce a successful dry-run CasePlan");
      }
      requestContext.set("case-plan", casePlan);
      requestContext.set("case-operation-phase", "execution");
      await options.events?.onPhase?.({ runId, phase: "workflow" });
      const workflowRunId = meterSphereCaseWorkflowRunId(options.trace?.jobId ?? context.requestId, casePlan.planHash);
      const receipt = options.caseOperationRunner
        ? await options.caseOperationRunner({ mastra, requestContext, plan: casePlan, workflowRunId })
        : await runMeterSphereCaseOperationWorkflow(mastra, requestContext, casePlan, workflowRunId);
      completionReceipt = validCaseCompletionReceipt(casePlan, receipt);
      if (!completionReceipt) throw new IncompleteOutcomeError("MeterSphere case workflow returned an invalid completion receipt");
      await options.events?.onCompletionCheckpoint?.({ runId, receipt: completionReceipt });
      finalization = "workflow";
      text = completionReceiptText(completionReceipt);
    } else if (caseIntent && completionReceipt) {
      finalization = "receipt";
      text = completionReceiptText(completionReceipt);
    } else {
      const agentText = selectFinalText(result);
      finalization = "agent";
      text = agentText;
    }
    if (!text) throw new IncompleteOutcomeError("Agent stopped without a standalone final answer");
    await options.events?.onPhase?.({ runId, phase: "finalizing" });
    const response: QaseyResponse = {
      text,
      route,
      runId,
      outcome: "success",
      finalization,
      evidenceStats: evidenceLedger.stats(),
      progress: agentProgress,
      ...(completionReceipt ? { completionReceipt } : {}),
    };
    requestTrace.span?.end({
      output: response,
      metadata: { outcome: response.outcome, intent: route.intent, writeTarget: route.writeTarget, finalization },
    });
    return response;
  } catch (error) {
    requestTrace.span?.error({
      error: error instanceof Error ? error : new Error(String(error)),
      endSpan: true,
      metadata: {
        outcome: "error",
        ...(route ? { intent: route.intent, writeTarget: route.writeTarget } : {}),
      },
    });
    throw error;
  }
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

function validCaseCompletionReceipt(
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
  const state = inspectAgentCompletion(result);
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

function isMeterSphereCaseIntent(intent: IntentRoute["intent"]): boolean {
  return intent === "case_create_full" || intent === "case_maintain_fast";
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
