import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  buildMeterSphereCasePlan,
  completeCaseOperationAgainstPlan,
  IncompleteOutcomeError,
  type MeterSphereCaseCompletionReceipt,
} from "../../../../packages/domain/src/index.ts";
import {
  executeMeterSphereCaseWorkflowTool,
  MeterSphereCaseCompletionReceiptSchema,
  meterSphereCaseWorkflowRunId,
  runMeterSphereCaseOperationWorkflow,
} from "../../workflows/metersphere-case-workflow.ts";
import type { QaseyExecutionEvents } from "./service.ts";

export const METERSPHERE_COMMIT_CASE_PLAN_TOOL_NAME = "metersphere_commit_case_plan";

const MeterSphereCommitCasePlanInputSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).min(1),
}).strict();

const commitByRequestContext = new WeakMap<object, {
  inputFingerprint: string;
  operation: Promise<MeterSphereCaseCompletionReceipt>;
}>();

/**
 * The only Agent-visible boundary for a real MeterSphere case write. It owns
 * dry-run validation, immutable plan creation, the durable write/read-back
 * workflow, and the verified receipt returned to the caller.
 */
export const meterSphereCommitCasePlanTool = createTool({
  id: METERSPHERE_COMMIT_CASE_PLAN_TOOL_NAME,
  description: "将已经确定的 MeterSphere 测试用例批量计划提交一次。该可信工具会先 dry-run 并冻结计划，再通过持久化 Workflow 执行真实写入、逐条独立回查并返回严格完成回执。不要直接调用原始写入工具。",
  inputSchema: MeterSphereCommitCasePlanInputSchema,
  outputSchema: MeterSphereCaseCompletionReceiptSchema,
  execute: async ({ items }, context) => {
    if (!context.mastra) throw new Error("Mastra runtime is required for MeterSphere case commits");
    const requestContext = context.requestContext as RequestContext<any>;
    const inputFingerprint = JSON.stringify(items);
    const previous = commitByRequestContext.get(requestContext);
    if (previous) {
      if (previous.inputFingerprint !== inputFingerprint) {
        throw new IncompleteOutcomeError("Concurrent MeterSphere commits in one Qasey request must use the same case plan");
      }
      return previous.operation;
    }
    const operation = commitMeterSphereCasePlan(
      context.mastra as Mastra,
      requestContext,
      items,
      context.abortSignal ?? new AbortController().signal,
    );
    commitByRequestContext.set(requestContext, { inputFingerprint, operation });
    try {
      return await operation;
    } finally {
      if (commitByRequestContext.get(requestContext)?.operation === operation) {
        commitByRequestContext.delete(requestContext);
      }
    }
  },
  toModelOutput: receipt => ({
    status: "committed_and_verified",
    casePlanHash: receipt.casePlanHash,
    verificationMode: receipt.verificationMode,
    itemCount: receipt.caseOperation.itemCount,
    createdCount: receipt.caseOperation.createdCount,
    updatedCount: receipt.caseOperation.updatedCount,
    verifiedCount: receipt.caseOperation.verifiedCount,
    modulePath: receipt.caseOperation.modulePath,
  }),
});

async function commitMeterSphereCasePlan(
  mastra: Mastra,
  requestContext: RequestContext<any>,
  items: Array<Record<string, unknown>>,
  abortSignal: AbortSignal,
): Promise<MeterSphereCaseCompletionReceipt> {
  abortSignal.throwIfAborted();
  const events = requestContext.get("qasey-execution-events") as QaseyExecutionEvents | undefined;
  const agentRunId = String(requestContext.get("qasey-agent-run-id") ?? requestContext.get("requestId") ?? "qasey");
  requestContext.set("case-operation-phase", "planning");
  const dryRunInput = { items: JSON.stringify(items), dry_run: true };
  const dryRunResult = await executeMeterSphereCaseWorkflowTool(
    "metersphere_ms_bulk_upsert_test_cases",
    dryRunInput,
    { mastra, requestContext, abortSignal },
  );
  const plan = buildMeterSphereCasePlan({ dryRunInput, dryRunResult });
  if (!plan) {
    throw new IncompleteOutcomeError("MeterSphere dry-run did not produce a complete immutable CasePlan");
  }

  const checkpointed = requestContext.get("case-plan") as { planHash?: unknown } | undefined;
  if (checkpointed?.planHash && checkpointed.planHash !== plan.planHash) {
    throw new IncompleteOutcomeError("This Qasey request already committed a different MeterSphere CasePlan");
  }
  requestContext.set("case-plan", plan);
  await events?.onCasePlanCheckpoint?.({ runId: agentRunId, plan });

  const stableRequestId = stableCommitRequestId(requestContext);
  const workflowRunId = meterSphereCaseWorkflowRunId(stableRequestId, plan.planHash);
  requestContext.set("case-operation-phase", "execution");
  await events?.onPhase?.({ runId: agentRunId, phase: "workflow" });
  const rawReceipt = await runMeterSphereCaseOperationWorkflow(mastra, requestContext, plan, workflowRunId);
  const operation = completeCaseOperationAgainstPlan(plan, rawReceipt.caseOperation);
  const receipt = operation && rawReceipt.casePlanHash === plan.planHash
    && rawReceipt.verificationMode === "separate_read_back"
    && operation.verificationMode === "separate_read_back"
    ? MeterSphereCaseCompletionReceiptSchema.parse({ ...rawReceipt, caseOperation: operation })
    : undefined;
  if (!receipt) {
    throw new IncompleteOutcomeError("MeterSphere case workflow returned an invalid completion receipt");
  }
  const completionReceipt = receipt as unknown as MeterSphereCaseCompletionReceipt;
  requestContext.set("case-completion-receipt", completionReceipt);
  await events?.onCompletionCheckpoint?.({ runId: agentRunId, receipt: completionReceipt });
  return completionReceipt;
}

function stableCommitRequestId(requestContext: RequestContext<any>): string {
  for (const key of ["jobId", "taskId", "executionId", "requestId"] as const) {
    const value = requestContext.get(key);
    if (typeof value === "string" && value.trim()) return value;
  }
  throw new Error("A stable trusted request id is required for MeterSphere case commits");
}
