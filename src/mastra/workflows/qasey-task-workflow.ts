import type { Mastra } from "@mastra/core/mastra";
import type { TracingContext } from "@mastra/core/observability";
import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  AgentProgressReportSchema,
  QaseyRequestContextSchema,
  type QaseyRequestContext,
} from "../../../packages/contracts/src/index.ts";
import {
  IncompleteOutcomeError,
  type MeterSphereCaseCompletionReceipt,
  type MeterSphereCasePlan,
} from "../../../packages/domain/src/index.ts";
import {
  initializeQaseyTraceRequestContext,
  startQaseyRequestSpan,
  type QaseyTraceContext,
} from "../applications/qasey/observability.ts";
import {
  assembleQaseyResponse,
  decideQaseyFinalization,
  prepareQaseyRequestContext,
  runQaseyAgentPhase,
  validateQaseyCompletionReceipt,
  type QaseyAgentPhaseResult,
  type QaseyExecutionEvents,
  type QaseyFinalizationDecision,
  type QaseyResponse,
} from "../applications/qasey/service.ts";
import {
  MeterSphereCaseCompletionReceiptSchema,
  MeterSphereCasePlanSchema,
  MeterSphereCaseWorkflowOutputSchema,
  meterSphereCaseOperationWorkflow,
  meterSphereCaseWorkflowRunId,
  prepareMeterSphereCaseOperationRequestContext,
} from "./metersphere-case-workflow.ts";
import { PlatformRequestContextSchema } from "../../platform/context/schema.ts";
import { assertJsonSafeSnapshot } from "../../platform/workflows/durability.ts";

const AgentCompletionStateSchema = z.object({
  finishReason: z.string().optional(),
  pendingToolCalls: z.number().int().nonnegative(),
});

const QaseyAgentPhaseSchema = z.object({
  context: QaseyRequestContextSchema,
  runId: z.string().min(1),
  agentText: z.string(),
  completionState: AgentCompletionStateSchema,
  casePlan: MeterSphereCasePlanSchema.optional(),
  progress: z.array(AgentProgressReportSchema),
});

const QaseyFinalizationDecisionSchema = QaseyAgentPhaseSchema.extend({
  finalization: z.enum(["agent", "workflow"]),
});

export const QaseyTaskOutputSchema = z.object({
  text: z.string().min(1),
  runId: z.string().min(1),
  outcome: z.literal("success"),
  finalization: z.enum(["agent", "workflow"]),
  completionReceipt: MeterSphereCaseCompletionReceiptSchema.optional(),
  progress: z.array(AgentProgressReportSchema),
});

const CompletedCaseBranchSchema = z.object({
  decision: QaseyFinalizationDecisionSchema,
  receipt: MeterSphereCaseCompletionReceiptSchema,
});

const FinalizationBranchesSchema = z.object({
  "finalize-agent-response": QaseyTaskOutputSchema.optional(),
  "qasey-metersphere-case-finalization": QaseyTaskOutputSchema.optional(),
});

const QASEY_WORKFLOW_EVENTS_KEY = "qasey-workflow-events";
const QASEY_WORKFLOW_RESUME_PLAN_KEY = "qasey-workflow-resume-plan";

const runSkillDrivenAgentStep = createStep({
  id: "run-skill-driven-agent",
  description: "由 Qasey Agent 基于 thread memory 选择 Agent Skill、发现所需工具，并输出可持久化完成检查点。",
  inputSchema: QaseyRequestContextSchema,
  outputSchema: QaseyAgentPhaseSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, mastra, requestContext, abortSignal, runId, tracingContext }) => {
    prepareQaseyRequestContext(inputData, requestContext);
    const events = requestContext.get(QASEY_WORKFLOW_EVENTS_KEY) as QaseyExecutionEvents | undefined;
    const resumeCasePlan = requestContext.get(QASEY_WORKFLOW_RESUME_PLAN_KEY) as MeterSphereCasePlan | undefined;
    const phase = await runQaseyAgentPhase(mastra, inputData, {
      runId,
      requestContext,
      abortSignal,
      ...(tracingContext ? { tracingContext } : {}),
      ...(events ? { events } : {}),
      ...(resumeCasePlan ? { resumeCasePlan } : {}),
    });
    assertJsonSafeSnapshot(phase);
    return phase;
  },
});

const determineFinalizationStep = createStep({
  id: "determine-finalization",
  description: "验证 Agent 完成状态，并选择直接回答或执行确定性写入 Workflow。",
  inputSchema: QaseyAgentPhaseSchema,
  outputSchema: QaseyFinalizationDecisionSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData }) => decideQaseyFinalization(inputData as unknown as QaseyAgentPhaseResult),
});

const finalizeAgentResponseStep = createStep({
  id: "finalize-agent-response",
  description: "将正常结束的 Agent 文本组装为 Qasey 响应。",
  inputSchema: QaseyFinalizationDecisionSchema,
  outputSchema: QaseyTaskOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext }) => {
    if (inputData.finalization !== "agent") throw new IncompleteOutcomeError("Agent finalization branch received the wrong decision");
    const events = requestContext.get(QASEY_WORKFLOW_EVENTS_KEY) as QaseyExecutionEvents | undefined;
    return assembleQaseyResponse(inputData as unknown as QaseyFinalizationDecision, undefined, events);
  },
});

const prepareCaseOperationStep = createStep({
  id: "prepare-metersphere-case-operation",
  description: "固定原生嵌套 Workflow 的 CasePlan、执行阶段和稳定外部写入幂等键。",
  inputSchema: QaseyFinalizationDecisionSchema,
  outputSchema: z.object({ plan: MeterSphereCasePlanSchema }),
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext }) => {
    if (inputData.finalization !== "workflow" || !inputData.casePlan) {
      throw new IncompleteOutcomeError("MeterSphere workflow branch requires a frozen CasePlan");
    }
    const events = requestContext.get(QASEY_WORKFLOW_EVENTS_KEY) as QaseyExecutionEvents | undefined;
    requestContext.set("case-plan", inputData.casePlan);
    requestContext.set("case-operation-phase", "execution");
    await events?.onPhase?.({ runId: inputData.runId, phase: "workflow" });
    const traceJobId = requestContext.get("jobId");
    const stableRequestId = typeof traceJobId === "string" && traceJobId ? traceJobId : inputData.context.requestId;
    prepareMeterSphereCaseOperationRequestContext(
      requestContext,
      meterSphereCaseWorkflowRunId(stableRequestId, inputData.casePlan.planHash),
    );
    return { plan: inputData.casePlan };
  },
});

const completeCaseOperationStep = createStep({
  id: "complete-metersphere-case-finalization",
  description: "验证嵌套 Workflow 回执与冻结计划完全匹配，并组装最终响应。",
  inputSchema: CompletedCaseBranchSchema,
  outputSchema: QaseyTaskOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext }) => {
    const plan = inputData.decision.casePlan;
    const receipt = validateQaseyCompletionReceipt(plan, inputData.receipt as MeterSphereCaseCompletionReceipt);
    if (!receipt) throw new IncompleteOutcomeError("MeterSphere case workflow returned an invalid completion receipt");
    const events = requestContext.get(QASEY_WORKFLOW_EVENTS_KEY) as QaseyExecutionEvents | undefined;
    await events?.onCompletionCheckpoint?.({ runId: inputData.decision.runId, receipt });
    return assembleQaseyResponse(inputData.decision as unknown as QaseyFinalizationDecision, receipt, events);
  },
});

const qaseyMeterSphereCaseFinalizationWorkflow = createWorkflow({
  id: "qasey-metersphere-case-finalization",
  description: "将 Agent 冻结的 CasePlan 原生交给 MeterSphere 写入、回查和完成回执 Workflow。",
  inputSchema: QaseyFinalizationDecisionSchema,
  outputSchema: QaseyTaskOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
})
  .then(prepareCaseOperationStep)
  // Mastra Workflows implement Step at runtime. The installed declaration's
  // optional description conflicts with exactOptionalPropertyTypes when nested.
  .then(meterSphereCaseOperationWorkflow as any)
  .map(async ({ inputData, getInitData }) => {
    const operationOutput = MeterSphereCaseWorkflowOutputSchema.parse(inputData);
    return {
      decision: getInitData<QaseyFinalizationDecision>(),
      receipt: operationOutput.receipt,
    };
  })
  .then(completeCaseOperationStep)
  .commit();

const assembleResponseStep = createStep({
  id: "assemble-response",
  description: "汇合互斥 finalization 分支，并返回统一的 Qasey 输出。",
  inputSchema: FinalizationBranchesSchema,
  outputSchema: QaseyTaskOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData }) => {
    const responses = [
      inputData["finalize-agent-response"],
      inputData["qasey-metersphere-case-finalization"],
    ].filter((response): response is QaseyResponse => Boolean(response));
    if (responses.length !== 1) throw new Error(`Expected one finalization response, received ${responses.length}`);
    return responses[0]!;
  },
});

export const qaseyTaskWorkflow = createWorkflow({
  id: "qasey-task",
  description: "权威的 Qasey 请求 Workflow：由主 Agent 选择 Skill、按需发现能力，并验证确定性完成状态。",
  inputSchema: QaseyRequestContextSchema,
  outputSchema: QaseyTaskOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
})
  .then(runSkillDrivenAgentStep)
  .then(determineFinalizationStep)
  .branch([
    [async ({ inputData }) => inputData.finalization === "agent", finalizeAgentResponseStep],
    [async ({ inputData }) => inputData.finalization === "workflow", qaseyMeterSphereCaseFinalizationWorkflow as any],
  ])
  .then(assembleResponseStep)
  .commit();

export interface RunQaseyTaskOptions {
  requestContext?: RequestContext<any>;
  tracingContext?: TracingContext;
  events?: QaseyExecutionEvents;
  abortSignal?: AbortSignal;
  runId?: string;
  trace?: QaseyTraceContext;
  resumeCasePlan?: MeterSphereCasePlan;
}

export async function runQaseyTaskWorkflow(
  mastra: Mastra,
  context: QaseyRequestContext,
  options: RunQaseyTaskOptions = {},
): Promise<QaseyResponse> {
  const requestContext = prepareQaseyRequestContext(context, options.requestContext);
  initializeQaseyTraceRequestContext(requestContext, context, options.trace);
  if (options.events) requestContext.set(QASEY_WORKFLOW_EVENTS_KEY, options.events);
  if (options.resumeCasePlan) requestContext.set(QASEY_WORKFLOW_RESUME_PLAN_KEY, options.resumeCasePlan);
  const workflow = mastra.getWorkflow("qasey-task");
  const run = await workflow.createRun({
    ...(options.runId ? { runId: options.runId } : {}),
    resourceId: requestContext.get("mastra__resourceId"),
  });
  const requestTrace = startQaseyRequestSpan(
    mastra,
    requestContext,
    context,
    run.runId,
    options.trace,
    options.tracingContext,
  );
  try {
    const result = await run.start({
      inputData: context,
      requestContext,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(requestTrace.tracingContext
        ? { tracingContext: requestTrace.tracingContext }
        : options.tracingContext
          ? { tracingContext: options.tracingContext }
          : {}),
    });
    if (result.status !== "success") {
      const detail = result.status === "failed" ? result.error.message : result.status;
      throw new Error(`Qasey task workflow did not complete: ${detail}`);
    }
    const response = QaseyTaskOutputSchema.parse(result.result) as QaseyResponse;
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
    requestContext.delete(QASEY_WORKFLOW_EVENTS_KEY);
    requestContext.delete(QASEY_WORKFLOW_RESUME_PLAN_KEY);
  }
}
