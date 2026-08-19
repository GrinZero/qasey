import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  AgentProgressReportSchema,
  IntentRouteSchema,
  QaseyRequestContextSchema,
  type QaseyRequestContext,
} from "../../packages/contracts/src/index.ts";
import type { EvidenceCompletionReceipt, MeterSphereCasePlan } from "../../packages/domain/src/index.ts";
import { routeIntent } from "./intent-agent.ts";
import {
  executeQasey,
  prepareQaseyRequestContext,
  type QaseyExecutionEvents,
  type QaseyResponse,
} from "./service.ts";
import { PlatformRequestContextSchema } from "../platform/context/schema.ts";

const RoutedTaskSchema = z.object({
  context: QaseyRequestContextSchema,
  route: IntentRouteSchema,
});

const EvidenceStatsSchema = z.object({
  actualExecutions: z.number().int().nonnegative(),
  deduplicatedCalls: z.number().int().nonnegative(),
  cachedFailures: z.number().int().nonnegative(),
  artifactReads: z.number().int().nonnegative(),
  artifactizedResults: z.number().int().nonnegative(),
  totalResultChars: z.number().int().nonnegative(),
  duplicateResultCharsAvoided: z.number().int().nonnegative(),
});

export const QaseyTaskOutputSchema = z.object({
  text: z.string().min(1),
  route: IntentRouteSchema,
  runId: z.string().min(1),
  outcome: z.literal("success"),
  finalization: z.enum(["agent", "receipt", "workflow"]),
  completionReceipt: z.unknown().optional(),
  evidenceStats: EvidenceStatsSchema,
  progress: z.array(AgentProgressReportSchema),
});

const QASEY_WORKFLOW_EVENTS_KEY = "qasey-workflow-events";
const QASEY_WORKFLOW_RESUME_PLAN_KEY = "qasey-workflow-resume-plan";
const QASEY_WORKFLOW_RESUME_RECEIPT_KEY = "qasey-workflow-resume-receipt";

const classifyIntentStep = createStep({
  id: "classify-intent",
  description: "Classify the request before Qasey's dynamic instructions and tools are resolved.",
  inputSchema: QaseyRequestContextSchema,
  outputSchema: RoutedTaskSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, mastra, requestContext, abortSignal, runId }) => {
    const events = requestContext.get(QASEY_WORKFLOW_EVENTS_KEY) as QaseyExecutionEvents | undefined;
    await events?.onPhase?.({ runId, phase: "routing" });
    const route = await routeIntent(
      inputData,
      [],
      abortSignal,
      mastra.getAgent("qasey-intent-router") as Agent<any, any, any, any, any>,
      { requestContext },
    );
    requestContext.set("intent-route", route);
    return { context: inputData, route };
  },
});

const executeRoutedTaskStep = createStep({
  id: "execute-routed-qasey",
  description: "Run Qasey with route-scoped instructions and tools, then hand deterministic writes to domain workflows.",
  inputSchema: RoutedTaskSchema,
  outputSchema: QaseyTaskOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, mastra, requestContext, abortSignal, runId }) => {
    const events = requestContext.get(QASEY_WORKFLOW_EVENTS_KEY) as QaseyExecutionEvents | undefined;
    const resumeCasePlan = requestContext.get(QASEY_WORKFLOW_RESUME_PLAN_KEY) as MeterSphereCasePlan | undefined;
    const resumeReceipt = requestContext.get(QASEY_WORKFLOW_RESUME_RECEIPT_KEY) as EvidenceCompletionReceipt | undefined;
    return executeQasey(mastra, inputData.context, {
      route: inputData.route,
      runId,
      requestContext,
      abortSignal,
      ...(events ? { events } : {}),
      ...(resumeCasePlan ? { resumeCasePlan } : {}),
      ...(resumeReceipt ? { resumeReceipt } : {}),
    });
  },
});

export const qaseyTaskWorkflow = createWorkflow({
  id: "qasey-task",
  description: "Authoritative Qasey request workflow: classify, execute with route-scoped capabilities, and verify completion.",
  inputSchema: QaseyRequestContextSchema,
  outputSchema: QaseyTaskOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
})
  .then(classifyIntentStep)
  .then(executeRoutedTaskStep)
  .commit();

export interface RunQaseyTaskOptions {
  requestContext?: RequestContext<any>;
  events?: QaseyExecutionEvents;
  abortSignal?: AbortSignal;
  runId?: string;
  resumeCasePlan?: MeterSphereCasePlan;
  resumeReceipt?: EvidenceCompletionReceipt;
}

export async function runQaseyTaskWorkflow(
  mastra: Mastra,
  context: QaseyRequestContext,
  options: RunQaseyTaskOptions = {},
): Promise<QaseyResponse> {
  const requestContext = prepareQaseyRequestContext(context, options.requestContext);
  if (options.events) requestContext.set(QASEY_WORKFLOW_EVENTS_KEY, options.events);
  if (options.resumeCasePlan) requestContext.set(QASEY_WORKFLOW_RESUME_PLAN_KEY, options.resumeCasePlan);
  if (options.resumeReceipt) requestContext.set(QASEY_WORKFLOW_RESUME_RECEIPT_KEY, options.resumeReceipt);
  const workflow = mastra.getWorkflow("qasey-task");
  const run = await workflow.createRun({
    ...(options.runId ? { runId: options.runId } : {}),
    resourceId: requestContext.get("mastra__resourceId"),
  });
  try {
    const result = await run.start({
      inputData: context,
      requestContext,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    if (result.status !== "success") {
      const detail = result.status === "failed" ? result.error.message : result.status;
      throw new Error(`Qasey task workflow did not complete: ${detail}`);
    }
    return QaseyTaskOutputSchema.parse(result.result) as QaseyResponse;
  } finally {
    requestContext.delete(QASEY_WORKFLOW_EVENTS_KEY);
    requestContext.delete(QASEY_WORKFLOW_RESUME_PLAN_KEY);
    requestContext.delete(QASEY_WORKFLOW_RESUME_RECEIPT_KEY);
  }
}
