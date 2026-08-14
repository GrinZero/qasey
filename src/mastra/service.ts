import { RequestContext } from "@mastra/core/request-context";
import type { Mastra } from "@mastra/core/mastra";
import type { IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { loadModelAttachments } from "../../packages/adapters/src/index.ts";
import { EvidenceLedger, IncompleteOutcomeError } from "../../packages/domain/src/index.ts";
import type { EvidenceCompletionReceipt } from "../../packages/domain/src/index.ts";
import type { EvidenceLedgerStats } from "../../packages/domain/src/index.ts";
import { routeIntent } from "./intent-agent.ts";
import { config } from "./runtime.ts";

export interface QaseyResponse {
  text: string;
  route: IntentRoute;
  runId: string;
  outcome: "success";
  completionReceipt?: EvidenceCompletionReceipt;
  evidenceStats: EvidenceLedgerStats;
}

export interface QaseyExecutionEvents {
  onPhase?: (event: { runId: string; phase: "routing" | "agent" | "finalizing" }) => void | Promise<void>;
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
  abortSignal?: AbortSignal;
  events?: QaseyExecutionEvents;
  timeoutMs?: number;
}

export async function executeQasey(mastra: Mastra, context: QaseyRequestContext, options: ExecuteQaseyOptions = {}): Promise<QaseyResponse> {
  const runId = crypto.randomUUID();
  const evidenceLedger = new EvidenceLedger(runId);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? config.QASEY_AGENT_TIMEOUT_MS);
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeoutSignal]) : timeoutSignal;
  await options.events?.onPhase?.({ runId, phase: "routing" });
  const route = await routeIntent(context, [], abortSignal, mastra.getAgent("intentRouterAgent"));
  const requestContext = new RequestContext();
  requestContext.set("qasey-context", context);
  requestContext.set("intent-route", route);
  requestContext.set("evidence-ledger", evidenceLedger);
  // Safe operational dimensions for DatadogBridge. Only the low-cardinality
  // fields are promoted as tags; requestId stays metadata for point lookups.
  requestContext.set("requestId", context.requestId);
  requestContext.set("channel", context.channel);
  requestContext.set("intent", route.intent);
  requestContext.set("writeTarget", route.writeTarget);
  const files = await loadModelAttachments(context.attachments, config);
  const prompt = files.length === 0 ? context.chatInput : [{
    role: "user" as const,
    content: [{ type: "text" as const, text: context.chatInput }, ...files],
  }];
  const toolStarts = new Map<string, number[]>();
  await options.events?.onPhase?.({ runId, phase: "agent" });
  const result = await mastra.getAgent("qaseyAgent").generate(prompt, {
    requestContext,
    runId,
    maxSteps: 80,
    abortSignal,
    memory: { thread: context.sessionId, resource: context.actor.id },
    toolCallConcurrency: 6,
    prepareStep: () => evidenceLedger.completionReceipt()
      ? { activeTools: [], toolChoice: "none" as const }
      : undefined,
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
      const progress = evidenceLedger.finishIteration(toolCalls.length);
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
  assertNormalCompletion(result);
  const text = selectFinalText(result);
  if (!text) throw new IncompleteOutcomeError("Agent stopped without a standalone final answer");
  const completionReceipt = evidenceLedger.completionReceipt();
  if ((route.intent === "case_create_full" || route.intent === "case_maintain_fast") && !completionReceipt) {
    throw new IncompleteOutcomeError("MeterSphere case operation did not produce a successful write followed by read-back verification");
  }
  await options.events?.onPhase?.({ runId, phase: "finalizing" });
  return {
    text,
    route,
    runId,
    outcome: "success",
    evidenceStats: evidenceLedger.stats(),
    ...(completionReceipt ? { completionReceipt } : {}),
  };
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
  if (!result || typeof result !== "object") throw new IncompleteOutcomeError("Agent returned an invalid result");
  const output = result as Record<string, unknown>;
  const steps = Array.isArray(output.steps) ? output.steps.filter(isRecord) : [];
  const lastStep = steps.at(-1);
  const finishReason = stringField(lastStep?.finishReason) ?? stringField(output.finishReason);
  if (finishReason && finishReason !== "stop") {
    throw new IncompleteOutcomeError(`Agent did not finish normally (finishReason=${finishReason})`);
  }
  const resultIds = new Set(steps.flatMap(step => arrayField(step.toolResults)).map(toolCallId).filter(Boolean));
  const pending = steps.flatMap(step => arrayField(step.toolCalls)).filter(call => {
    const id = toolCallId(call);
    return id && !resultIds.has(id);
  });
  if (pending.length > 0) throw new IncompleteOutcomeError(`Agent stopped with ${pending.length} unfinished tool call(s)`);
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
