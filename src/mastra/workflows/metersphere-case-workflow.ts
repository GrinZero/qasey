import { createHash } from "node:crypto";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  buildMeterSphereCaseOperationReceipt,
  completeCaseOperationAgainstPlan,
  createSourceKey,
  extractCaseRecordsFromResult,
  IncompleteOutcomeError,
  validateMeterSphereCasePlan,
} from "../../../packages/domain/src/index.ts";
import type {
  EvidenceCompletionReceipt,
  EvidenceManifestEntry,
  MeterSphereCasePlan,
} from "../../../packages/domain/src/index.ts";
import { config, getRuntimeContext, mcpCatalog, mcpSubject } from "../runtime.ts";
import { PlatformRequestContextSchema } from "../../platform/context/schema.ts";
import { ownerScopeFromRequestContext } from "../../platform/context/owner-scope.ts";
import { externalWriteIdempotencyKey } from "../../platform/workflows/durability.ts";

const ManifestSchema = z.object({
  sourceKey: z.string(),
  toolName: z.string(),
  status: z.enum(["in_flight", "acquired", "failed"]),
  attempts: z.number().int().nonnegative(),
  artifactId: z.string().optional(),
  contentHash: z.string().optional(),
  totalChars: z.number().int().nonnegative().optional(),
  retryable: z.boolean().optional(),
  errorCode: z.string().optional(),
  completedAt: z.number().optional(),
  startedSequence: z.number().optional(),
  completedSequence: z.number().optional(),
});

const CaseRecordSchema = z.object({
  id: z.string(),
  num: z.union([z.string(), z.number()]),
  name: z.string(),
  priority: z.string(),
  verified: z.boolean(),
  nodeId: z.string().optional(),
  nodePath: z.string().optional(),
});

const CaseOperationSchema = z.object({
  moduleId: z.string(),
  modulePath: z.string(),
  featureName: z.string(),
  cases: z.array(CaseRecordSchema),
  itemCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  verifiedCount: z.number().int().nonnegative(),
  verificationMode: z.enum(["internal_read_back", "separate_read_back"]),
});

const CasePlanSchema = z.object({
  version: z.literal(1),
  planHash: z.string(),
  evidenceSnapshotHash: z.string(),
  payloadHash: z.string(),
  plannedCount: z.number().int().positive(),
  cases: z.array(z.object({
    key: z.string(),
    operation: z.enum(["create", "update"]),
    name: z.string(),
    order: z.number().int().positive(),
    targetModuleId: z.string(),
    targetModulePath: z.string(),
    caseId: z.string().optional(),
  })),
  targetModules: z.array(z.object({ id: z.string(), path: z.string() })),
  writeItems: z.array(z.record(z.string(), z.unknown())),
});

const WorkflowInputSchema = z.object({ plan: CasePlanSchema });
const WriteOutputSchema = z.object({
  plan: CasePlanSchema,
  operation: CaseOperationSchema,
  write: ManifestSchema,
});
const ReceiptSchema = z.object({
  casePlanHash: z.string(),
  write: ManifestSchema,
  verification: ManifestSchema,
  verificationMode: z.enum(["internal_read_back", "separate_read_back"]),
  caseOperation: CaseOperationSchema.optional(),
});
const VerificationOutputSchema = z.object({ receipt: ReceiptSchema });
const WorkflowOutputSchema = z.object({ receipt: ReceiptSchema });

export type MeterSphereCaseWorkflowToolExecutor = (
  toolName: string,
  input: unknown,
  context: { mastra: Mastra; requestContext: RequestContext<any>; abortSignal: AbortSignal },
) => Promise<unknown>;

const freezeDryRunPlan = createStep({
  id: "freeze-dry-run-plan",
  description: "验证成功的 dry-run 输出，并冻结不可变且有序的 CasePlan。",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowInputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext }) => {
    const plan = validateMeterSphereCasePlan(inputData.plan);
    const checkpointedPlan = validateMeterSphereCasePlan(requestContext.get("case-plan"));
    if (checkpointedPlan.planHash !== plan.planHash) {
      throw new IncompleteOutcomeError("Workflow CasePlan does not match the request checkpoint");
    }
    return { plan };
  },
});

const writeFrozenPlan = createStep({
  id: "write-frozen-plan",
  description: "写入完全匹配的冻结 CasePlan payload；Agent 无法调用此变更步骤。",
  inputSchema: WorkflowInputSchema,
  outputSchema: WriteOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, mastra, requestContext, abortSignal }) => {
    const plan = validateMeterSphereCasePlan(inputData.plan);
    const writeInput = { items: JSON.stringify(plan.writeItems), dry_run: false };
    const result = await executeWorkflowTool(
      "metersphere_ms_bulk_upsert_test_cases",
      writeInput,
      { mastra, requestContext, abortSignal },
    );
    const operation = completeCaseOperationAgainstPlan(plan, buildMeterSphereCaseOperationReceipt({
      writeInput,
      writeResult: result,
    }));
    if (!operation) {
      throw new IncompleteOutcomeError("MeterSphere bulk write did not return a complete verified result for the frozen CasePlan");
    }
    return {
      plan,
      operation,
      write: acquiredManifest(
        "metersphere_ms_bulk_upsert_test_cases",
        createSourceKey("metersphere_ms_bulk_upsert_test_cases", writeInput),
      ),
    };
  },
});

const verifyFreshReadBack = createStep({
  id: "verify-fresh-read-back",
  description: "通过全新的详情读取调用回读每条已写入用例，并比较标识、模块、名称和优先级。",
  inputSchema: WriteOutputSchema,
  outputSchema: VerificationOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  retries: 1,
  execute: async ({ inputData, mastra, requestContext, abortSignal }) => {
    const { plan, operation: internal, write } = inputData;
    const readBackCases = await mapWithConcurrency(internal.cases, 6, async (written, index) => {
      const result = await executeWorkflowTool(
        "metersphere_ms_get_test_case_detail",
        { case_id: written.id },
        { mastra, requestContext, abortSignal },
      );
      const actual = extractCaseRecordsFromResult(result).find(candidate => candidate.id === written.id);
      const planned = plan.cases[index];
      const plannedInput = plan.writeItems[index];
      const expectedPriority = stringValue(plannedInput?.priority);
      if (!actual || !planned
        || actual.name !== written.name
        || (expectedPriority && actual.priority !== expectedPriority)
        || normalizePath(actual.nodePath) !== normalizePath(planned.targetModulePath)) {
        throw new IncompleteOutcomeError(`Fresh MeterSphere read-back did not match CasePlan item ${planned?.key ?? index + 1}`);
      }
      return {
        ...actual,
        verified: true,
        nodeId: planned.targetModuleId,
        nodePath: planned.targetModulePath,
      };
    });
    const separateOperation = completeCaseOperationAgainstPlan(plan, {
      ...internal,
      cases: readBackCases,
      verifiedCount: readBackCases.length,
      verificationMode: "separate_read_back",
    });
    if (!separateOperation) {
      throw new IncompleteOutcomeError("Fresh MeterSphere read-back did not cover the complete frozen CasePlan");
    }
    const verificationKey = `metersphere-case-read-back:${plan.planHash}`;
    return {
      receipt: {
        casePlanHash: plan.planHash,
        write,
        verification: {
          ...acquiredManifest("metersphere_ms_get_test_case_detail", verificationKey),
          contentHash: createHash("sha256").update(JSON.stringify(readBackCases)).digest("hex"),
        },
        verificationMode: "separate_read_back" as const,
        caseOperation: separateOperation,
      },
    };
  },
});

const checkpointCompletion = createStep({
  id: "checkpoint-completion",
  description: "将可序列化且已验证的完成回执持久化为 Workflow 结果。",
  inputSchema: VerificationOutputSchema,
  outputSchema: WorkflowOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData }) => ({ receipt: inputData.receipt }),
});

export const meterSphereCaseOperationWorkflow = createWorkflow({
  id: "qasey-metersphere-case-operation",
  description: "确定性的 MeterSphere CasePlan 写入、独立回查和持久化完成检查点。",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
})
  .then(freezeDryRunPlan)
  .then(writeFrozenPlan)
  .then(verifyFreshReadBack)
  .then(checkpointCompletion)
  .commit();

export async function runMeterSphereCaseOperationWorkflow(
  mastra: Mastra,
  requestContext: RequestContext<any>,
  plan: MeterSphereCasePlan,
  runId: string,
): Promise<EvidenceCompletionReceipt> {
  const owner = ownerScopeFromRequestContext(requestContext);
  requestContext.set("externalWriteIdempotencyKey", externalWriteIdempotencyKey({
    ...owner,
    workflowId: "qasey-metersphere-case-operation",
    runId,
    effect: "metersphere-case-write",
  }));
  const workflow = mastra.getWorkflow("qasey-metersphere-case-operation");
  const persisted = await workflow.getWorkflowRunById(runId, { fields: ["result", "error"] });
  if (persisted?.status === "success") return persistedReceipt(persisted.result);

  const run = await workflow.createRun({ runId });
  const result = !persisted || persisted.status === "pending"
    ? await run.start({ inputData: { plan }, requestContext })
    : persisted.status === "running" || persisted.status === "failed"
      ? await run.restart({ requestContext })
      : undefined;
  if (!result) throw new IncompleteOutcomeError(`MeterSphere case workflow cannot continue from status ${persisted?.status}`);
  if (result.status !== "success") {
    const detail = result.status === "failed" ? result.error.message : result.status;
    throw new IncompleteOutcomeError(`MeterSphere case workflow did not complete: ${detail}`);
  }
  return ReceiptSchema.parse(result.result.receipt) as EvidenceCompletionReceipt;
}

export function meterSphereCaseWorkflowRunId(stableRequestId: string, planHash: string): string {
  const digest = createHash("sha256").update(`${stableRequestId}:${planHash}`).digest("hex").slice(0, 32);
  return `metersphere-case-${digest}`;
}

async function executeWorkflowTool(
  toolName: string,
  input: unknown,
  context: { mastra: Mastra; requestContext: RequestContext<any>; abortSignal: AbortSignal },
): Promise<unknown> {
  context.abortSignal.throwIfAborted();
  if (config.QASEY_SHADOW_MODE) throw new Error("MeterSphere case workflow writes are disabled in shadow mode");
  const injected = context.requestContext.get("case-operation-tool-executor");
  if (typeof injected === "function") {
    return (injected as MeterSphereCaseWorkflowToolExecutor)(toolName, input, context);
  }
  const runtime = getRuntimeContext(context.requestContext);
  const tools = await mcpCatalog.toolsFor(runtime["intent-route"], runtime["qasey-context"].channel, mcpSubject(context.requestContext));
  const tool = tools[toolName] as { execute?: (input: unknown, context: unknown) => Promise<unknown> } | undefined;
  if (!tool?.execute) throw new Error(`Required MeterSphere workflow tool is unavailable: ${toolName}`);
  return tool.execute(input, context);
}

function acquiredManifest(toolName: string, sourceKey: string): EvidenceManifestEntry {
  return { sourceKey, toolName, status: "acquired", attempts: 1, completedAt: Date.now() };
}

function persistedReceipt(result: Record<string, unknown> | undefined): EvidenceCompletionReceipt {
  const parsed = WorkflowOutputSchema.safeParse(result);
  if (!parsed.success) throw new IncompleteOutcomeError("Persisted MeterSphere workflow result is invalid");
  return parsed.data.receipt as EvidenceCompletionReceipt;
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function normalizePath(value: string | undefined): string {
  const normalized = value?.trim().replace(/\\+/g, "/").replace(/\/$/, "") ?? "";
  return normalized && !normalized.startsWith("/") ? `/${normalized}` : normalized;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().toUpperCase() : "";
}
