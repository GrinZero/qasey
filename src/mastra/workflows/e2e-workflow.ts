import { randomUUID } from "node:crypto";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  QaVerdictSchema,
  RunStatusSchema,
  type CreateE2ERun,
  type E2ERun,
  type OwnerScope,
  type QaVerdict,
} from "../../../packages/contracts/src/index.ts";
import { testCaseSpecFromMeterSphere } from "../../../packages/domain/src/index.ts";
import { config, e2eCoordinator, getRuntimeContext, githubClient, mcpCatalog, mcpSubject, runRepository } from "../runtime.ts";
import { ownerScopeFromRequestContext } from "../../platform/context/owner-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, PlatformRequestContextSchema } from "../../platform/context/schema.ts";
import { startQaseyCorrelatedSpan } from "../applications/qasey/observability.ts";

const WorkflowInputSchema = z.object({
  runId: z.string().min(1),
  qaFeedback: z.string().min(1).optional(),
});
const WorkflowOutputSchema = z.object({
  runId: z.string().min(1),
  status: RunStatusSchema,
});

const freezeExecutionBriefStep = createStep({
  id: "freeze-e2e-execution-brief",
  description: "冻结同会话上下文、MeterSphere 完整用例、仓库 base SHA 与固定执行配置。",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowInputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext, abortSignal, mastra }) => {
    const owner = ownerScopeFromRequestContext(requestContext);
    const run = await runRepository.get(owner, inputData.runId);
    if (!run) throw new Error(`E2E run ${inputData.runId} not found`);
    if (run.executionBrief) return inputData;
    if (run.contextSnapshot.blockingQuestions.length > 0) {
      throw new Error(`E2E context has unresolved blocking questions: ${run.contextSnapshot.blockingQuestions.join("; ")}`);
    }
    const injected = requestContext.get("e2e-case-detail-executor");
    const tools = typeof injected === "function"
      ? undefined
      : await mcpCatalog.toolsForCaseWorkflow(getRuntimeContext(requestContext)["qasey-context"].channel, mcpSubject(requestContext));
    const cases = await mapWithConcurrency(run.sourceCaseIds, 6, async caseId => {
      abortSignal.throwIfAborted();
      const result = typeof injected === "function"
        ? await (injected as (caseId: string) => Promise<unknown>)(caseId)
        : await (tools?.metersphere_ms_get_test_case_detail as { execute?: (input: unknown, context: unknown) => Promise<unknown> } | undefined)?.execute?.(
          { case_id: caseId },
          { mastra, requestContext, abortSignal },
        );
      if (result === undefined) throw new Error("Required MeterSphere case detail tool is unavailable");
      return testCaseSpecFromMeterSphere(caseId, result);
    });
    if (cases.some(testCase => testCase.target !== "web")) throw new Error("Web E2E MVP only accepts MeterSphere cases targeting web");
    let baseSha = run.baseSha;
    if (!baseSha) {
      if (!githubClient) throw new Error("GitHub read client is required to freeze the E2E base SHA");
      const commit = await githubClient.repos.getCommit({ owner: run.repository.owner, repo: run.repository.repository, ref: run.repository.baseRef });
      baseSha = commit.data.sha;
    }
    await tracedE2EOperation(mastra, requestContext, "qasey e2e context freeze", { runId: run.id, caseCount: cases.length, baseSha }, () => e2eCoordinator.freezeExecutionBrief(owner, run.id, cases, {
      owner: run.repository.owner,
      repository: run.repository.repository,
      workspacePath: `repos/${run.repository.owner}/${run.repository.repository}`,
      baseSha,
      allowedPaths: run.repository.allowedPaths,
      skillPaths: run.repository.skillsPaths,
      ...(run.repository.installCommand ? { installCommand: run.repository.installCommand } : {}),
      testCommand: ["pnpm", "exec", "playwright", "test", "--config=<changed-project>", "--project=t2"],
      specGlobs: run.repository.allowedPaths,
      artifactGlobs: ["artifacts/**", "playwright-report/**", "test-results/**"],
    }, requestContext.get("qasey__traceId") as string | undefined));
    await runRepository.update(owner, run.id, { baseSha });
    return inputData;
  },
});

const authorAndPersistPatch = createStep({
  id: "author-and-persist-patch",
  description: "编写 E2E 代码，执行次数受限的修复，验证变更路径并持久化补丁。",
  inputSchema: WorkflowInputSchema,
  outputSchema: z.object({ runId: z.string().min(1) }),
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext, mastra }) => {
    const owner = ownerScopeFromRequestContext(requestContext);
    try {
      await tracedE2EOperation(mastra, requestContext, "qasey e2e author", { runId: inputData.runId }, () => e2eCoordinator.authorAndPersistPatch(owner, inputData.runId, inputData.qaFeedback));
    } catch (error) {
      await e2eCoordinator.fail(owner, inputData.runId, error);
      throw error;
    }
    return { runId: inputData.runId };
  },
});

const cleanVerifyAndPublish = createStep({
  id: "clean-verify-and-publish",
  description: "在全新的工作区应用已持久化的补丁，完成验证并发布 Draft PR。",
  inputSchema: z.object({ runId: z.string().min(1) }),
  outputSchema: z.object({ runId: z.string().min(1) }),
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext, mastra }) => {
    const owner = ownerScopeFromRequestContext(requestContext);
    try {
      await tracedE2EOperation(mastra, requestContext, "qasey e2e verifier and draft pr", { runId: inputData.runId }, () => e2eCoordinator.cleanVerifyAndPublish(owner, inputData.runId));
    } catch (error) {
      await e2eCoordinator.fail(owner, inputData.runId, error);
      throw error;
    }
    const run = await runRepository.get(owner, inputData.runId);
    if (!run || run.status === "failed") throw new Error(run?.error ?? `E2E run ${inputData.runId} failed`);
    if (run.status !== "awaiting_qa") throw new Error(`E2E run ${inputData.runId} stopped in ${run.status}`);
    return { runId: inputData.runId };
  },
});

export const awaitQaVerdictStep = createStep({
  id: "await-qa-verdict",
  description: "完成干净验证后暂停，等待 QA 批准或提出次数受限的修复要求。",
  inputSchema: z.object({ runId: z.string().min(1) }),
  outputSchema: WorkflowOutputSchema,
  suspendSchema: z.object({ runId: z.string(), reason: z.string(), reviewUrl: z.string().url() }),
  resumeSchema: QaVerdictSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, resumeData, suspend, requestContext }) => {
    const owner = ownerScopeFromRequestContext(requestContext);
    if (!resumeData) {
      return await suspend({
        runId: inputData.runId,
        reason: "Clean verifier passed; explicit QA verdict required.",
        reviewUrl: `${config.QASEY_PUBLIC_BASE_URL.replace(/\/$/, "")}/runs/${inputData.runId}`,
      });
    }

    const updated = await e2eCoordinator.verdict(owner, inputData.runId, resumeData);
    if (resumeData.verdict === "approve") return { runId: updated.id, status: updated.status };

    try {
      await e2eCoordinator.authorAndPersistPatch(owner, inputData.runId, resumeData.feedback);
      await e2eCoordinator.cleanVerifyAndPublish(owner, inputData.runId);
    } catch (error) {
      await e2eCoordinator.fail(owner, inputData.runId, error);
      throw error;
    }
    const repaired = await runRepository.get(owner, inputData.runId);
    if (!repaired || repaired.status === "failed") throw new Error(repaired?.error ?? `E2E repair ${inputData.runId} failed`);
    if (repaired.status !== "awaiting_qa") throw new Error(`E2E repair ${inputData.runId} stopped in ${repaired.status}`);
    return await suspend({
      runId: inputData.runId,
      reason: "QA feedback was applied and the clean verifier passed again; a new verdict is required.",
      reviewUrl: `${config.QASEY_PUBLIC_BASE_URL.replace(/\/$/, "")}/runs/${inputData.runId}`,
    });
  },
});

export const e2eLifecycleWorkflow = createWorkflow({
  id: "qasey-e2e-lifecycle",
  description: "持久化的 E2E 编写、干净验证与 QA 审批生命周期。",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
})
  .then(freezeExecutionBriefStep)
  .then(authorAndPersistPatch)
  .then(cleanVerifyAndPublish)
  .then(awaitQaVerdictStep)
  .commit();

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function tracedE2EOperation<T>(
  mastra: Mastra | undefined,
  requestContext: RequestContext<any>,
  name: string,
  metadata: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const span = startQaseyCorrelatedSpan(mastra, requestContext, name, metadata);
  try {
    const result = await operation();
    span?.end();
    return result;
  } catch (error) {
    span?.error({ error: error instanceof Error ? error : new Error(String(error)), endSpan: true });
    throw error;
  }
}

export async function createAndStartE2ERun(
  mastra: Mastra,
  owner: OwnerScope,
  input: CreateE2ERun,
  requestContext: RequestContext,
  resourceId?: string,
): Promise<E2ERun> {
  const requestId = String(requestContext.get("requestId") ?? input.requestId ?? randomUUID());
  const sessionId = String(requestContext.get("sessionId") ?? input.sourceSessionId);
  const resource = String(requestContext.get(MASTRA_RESOURCE_ID_KEY) ?? resourceId ?? "api");
  const created = await e2eCoordinator.create(owner, { ...input, requestId, sourceSessionId: sessionId }, {
    sessionId,
    threadId: String(requestContext.get(MASTRA_THREAD_ID_KEY) ?? sessionId),
    taskRunId: String(requestContext.get("taskId") ?? requestContext.get("executionId") ?? requestId),
    requestId,
    resourceId: resource,
  });
  if (!config.QASEY_ENABLE_EXECUTION) return created;
  const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
  const run = await workflow.createRun({ runId: created.id, ...(resourceId ? { resourceId } : {}) });
  try {
    await run.startAsync({ inputData: { runId: created.id }, requestContext });
  } catch (error) {
    await e2eCoordinator.fail(owner, created.id, error);
    throw error;
  }
  return created;
}

export async function rerunE2E(mastra: Mastra, owner: OwnerScope, runId: string, requestContext: RequestContext, resourceId?: string): Promise<E2ERun> {
  const created = await e2eCoordinator.rerun(owner, runId);
  if (!config.QASEY_ENABLE_EXECUTION) return created;
  const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
  const run = await workflow.createRun({ runId: created.id, ...(resourceId ? { resourceId } : {}) });
  try {
    await run.startAsync({ inputData: { runId: created.id }, requestContext });
  } catch (error) {
    await e2eCoordinator.fail(owner, created.id, error);
    throw error;
  }
  return created;
}

export async function resumeE2EWithVerdict(mastra: Mastra, owner: OwnerScope, runId: string, verdict: QaVerdict, requestContext: RequestContext): Promise<E2ERun> {
  if (!config.QASEY_ENABLE_EXECUTION) return e2eCoordinator.verdict(owner, runId, verdict);
  if (!await runRepository.get(owner, runId)) throw new Error(`Run ${runId} not found`);
  const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
  const run = await workflow.createRun({ runId });
  await run.resume({ step: awaitQaVerdictStep, resumeData: verdict, requestContext });
  const updated = await runRepository.get(owner, runId);
  if (!updated) throw new Error(`Run ${runId} not found after workflow resume`);
  return updated;
}

export async function cancelE2ERun(mastra: Mastra, owner: OwnerScope, runId: string): Promise<E2ERun> {
  if (!await runRepository.get(owner, runId)) throw new Error(`Run ${runId} not found`);
  if (config.QASEY_ENABLE_EXECUTION) {
    const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
    const run = await workflow.createRun({ runId });
    await run.cancel();
  }
  return e2eCoordinator.cancel(owner, runId);
}
