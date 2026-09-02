import { randomUUID } from "node:crypto";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  QaVerdictSchema,
  RunStatusSchema,
  type CreateE2ERun,
  type ArtifactRef,
  type E2ERun,
  type OwnerScope,
  type QaVerdict,
} from "../../../packages/contracts/src/index.ts";
import { caseHubVersionToTestCase, type CaseExecutionObservation } from "../../../packages/domain/src/index.ts";
import { artifactStore, caseHubRepository, config, e2eCoordinator, getRuntimeContext, githubClient, runRepository } from "../runtime.ts";
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
  description: "冻结同会话需求、Case Hub 候选版本、仓库 base SHA 与固定执行配置。",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowInputSchema,
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext, abortSignal, mastra }) => {
    const owner = ownerScopeFromRequestContext(requestContext);
    const run = await runRepository.get(owner, inputData.runId);
    if (!run) throw new Error(`E2E run ${inputData.runId} not found`);
    if (run.executionBrief) return inputData;
    if (!run.playwrightVerification) {
      throw new Error("This legacy E2E run has no frozen Playwright verification mapping; create a new run");
    }
    const playwrightVerification = run.playwrightVerification;
    if (run.contextSnapshot.blockingQuestions.length > 0) {
      throw new Error(`E2E context has unresolved blocking questions: ${run.contextSnapshot.blockingQuestions.join("; ")}`);
    }
    abortSignal.throwIfAborted();
    const changeSet = await caseHubRepository.getChangeSet(owner, run.changeSetId);
    if (!changeSet) throw new Error(`Case Hub change set ${run.changeSetId} not found`);
    const versions = await caseHubRepository.versionsForChangeSet(owner, changeSet.id);
    if (versions.length === 0) throw new Error("Case Hub change set contains no proposed cases");
    const cases = versions.map(caseHubVersionToTestCase);
    let baseSha = changeSet.baseSha ?? run.baseSha;
    if (!baseSha) {
      if (!githubClient) throw new Error("GitHub read client is required to freeze the E2E base SHA");
      const commit = await githubClient.repos.getCommit({ owner: run.repository.owner, repo: run.repository.repository, ref: run.repository.baseRef });
      baseSha = commit.data.sha;
    }
    if (changeSet.environmentSourceSha && changeSet.environmentSourceSha !== baseSha) {
      await caseHubRepository.updateChangeSet(owner, changeSet.id, changeSet.revision, {
        status: "blocked_environment",
        error: `environment_version_mismatch: expected ${baseSha}, received ${changeSet.environmentSourceSha}`,
      });
      throw new Error("environment_version_mismatch");
    }
    const frozen = await tracedE2EOperation(mastra, requestContext, "qasey e2e context freeze", { runId: run.id, caseCount: cases.length, baseSha }, () => e2eCoordinator.freezeExecutionBrief(owner, run.id, cases, {
      owner: run.repository.owner,
      repository: run.repository.repository,
      workspacePath: `repos/${run.repository.owner}/${run.repository.repository}`,
      baseSha,
      allowedPaths: run.repository.allowedPaths,
      skillPaths: run.repository.skillsPaths,
      ...(run.repository.installCommand ? { installCommand: run.repository.installCommand } : {}),
      testCommand: ["pnpm", "exec", "playwright", "test", "--config=<changed-project>", "--project=<configured-project>"],
      specGlobs: run.repository.allowedPaths,
      artifactGlobs: ["artifacts/**", "playwright-report/**", "test-results/**"],
      verification: playwrightVerification,
    }, requestContext.get("qasey__traceId") as string | undefined));
    await runRepository.update(owner, run.id, frozen.revision, { baseSha });
    const latestChangeSet = await caseHubRepository.getChangeSet(owner, changeSet.id);
    if (latestChangeSet && latestChangeSet.status === "authoring") {
      await caseHubRepository.updateChangeSet(owner, changeSet.id, latestChangeSet.revision, { status: "verifying", baseSha, runId: run.id });
    }
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
      await failChangeSet(owner, inputData.runId, error);
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
      await failChangeSet(owner, inputData.runId, error);
      throw error;
    }
    const run = await runRepository.get(owner, inputData.runId);
    if (!run || run.status === "failed") throw new Error(run?.error ?? `E2E run ${inputData.runId} failed`);
    if (run.status !== "awaiting_qa") throw new Error(`E2E run ${inputData.runId} stopped in ${run.status}`);
    const changeSet = await caseHubRepository.getChangeSet(owner, run.changeSetId);
    if (!changeSet) throw new Error(`Case Hub change set ${run.changeSetId} not found`);
    const versions = await caseHubRepository.versionsForChangeSet(owner, changeSet.id);
    await caseHubRepository.createPendingResults(owner, changeSet.id, run.id, run.artifacts, undefined, await playwrightObservations(owner, run.artifacts, versions.map(version => version.caseId)));
    const refreshed = await caseHubRepository.getChangeSet(owner, changeSet.id);
    if (refreshed && refreshed.status === "verifying") {
      await caseHubRepository.updateChangeSet(owner, refreshed.id, refreshed.revision, {
        status: "awaiting_review", branch: run.branch, pullRequestUrl: run.pullRequestUrl,
      });
    }
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

    if (resumeData.verdict === "approve") {
      try {
        await e2eCoordinator.cleanVerifyAndPublish(owner, inputData.runId, true);
        const updated = await e2eCoordinator.verdict(owner, inputData.runId, resumeData);
        return { runId: updated.id, status: updated.status };
      } catch (error) {
        await e2eCoordinator.fail(owner, inputData.runId, error);
        await failChangeSet(owner, inputData.runId, error);
        throw error;
      }
    }
    const updated = await e2eCoordinator.verdict(owner, inputData.runId, resumeData);

    try {
      await e2eCoordinator.authorAndPersistPatch(owner, inputData.runId, resumeData.feedback);
      const runBeforeVerification = await runRepository.get(owner, inputData.runId);
      const changeSetBeforeVerification = runBeforeVerification
        ? await caseHubRepository.getChangeSet(owner, runBeforeVerification.changeSetId)
        : undefined;
      if (changeSetBeforeVerification?.status === "revising") {
        await caseHubRepository.updateChangeSet(owner, changeSetBeforeVerification.id, changeSetBeforeVerification.revision, { status: "verifying" });
      }
      await e2eCoordinator.cleanVerifyAndPublish(owner, inputData.runId);
    } catch (error) {
      await e2eCoordinator.fail(owner, inputData.runId, error);
      await failChangeSet(owner, inputData.runId, error);
      throw error;
    }
    const repaired = await runRepository.get(owner, inputData.runId);
    if (!repaired || repaired.status === "failed") throw new Error(repaired?.error ?? `E2E repair ${inputData.runId} failed`);
    if (repaired.status !== "awaiting_qa") throw new Error(`E2E repair ${inputData.runId} stopped in ${repaired.status}`);
    const repairedChangeSet = await caseHubRepository.getChangeSet(owner, repaired.changeSetId);
    if (!repairedChangeSet) throw new Error(`Case Hub change set ${repaired.changeSetId} not found`);
    const repairedVersions = await caseHubRepository.versionsForChangeSet(owner, repairedChangeSet.id);
    const repairedCaseIds = repairedVersions
      .filter(version => !resumeData.caseVersionId || version.id === resumeData.caseVersionId)
      .map(version => version.caseId);
    await caseHubRepository.createPendingResults(
      owner,
      repairedChangeSet.id,
      repaired.id,
      repaired.artifacts,
      resumeData.caseVersionId ? [resumeData.caseVersionId] : undefined,
      await playwrightObservations(owner, repaired.artifacts, repairedCaseIds),
    );
    const refreshedChangeSet = await caseHubRepository.getChangeSet(owner, repairedChangeSet.id);
    if (refreshedChangeSet?.status === "verifying") {
      await caseHubRepository.updateChangeSet(owner, refreshedChangeSet.id, refreshedChangeSet.revision, {
        status: "awaiting_review",
        branch: repaired.branch,
        pullRequestUrl: repaired.pullRequestUrl,
      });
    }
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
  const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
  const run = await workflow.createRun({ runId: created.id, ...(resourceId ? { resourceId } : {}) });
  try {
    await run.startAsync({ inputData: { runId: created.id }, requestContext });
  } catch (error) {
    await e2eCoordinator.fail(owner, created.id, error);
    await failChangeSet(owner, created.id, error);
    throw error;
  }
  return created;
}

export async function rerunE2E(mastra: Mastra, owner: OwnerScope, runId: string, requestContext: RequestContext, resourceId?: string): Promise<E2ERun> {
  const created = await e2eCoordinator.rerun(owner, runId);
  const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
  const run = await workflow.createRun({ runId: created.id, ...(resourceId ? { resourceId } : {}) });
  try {
    await run.startAsync({ inputData: { runId: created.id }, requestContext });
  } catch (error) {
    await e2eCoordinator.fail(owner, created.id, error);
    await failChangeSet(owner, created.id, error);
    throw error;
  }
  return created;
}

export async function resumeE2EWithVerdict(mastra: Mastra, owner: OwnerScope, runId: string, verdict: QaVerdict, requestContext: RequestContext): Promise<E2ERun> {
  if (!await runRepository.get(owner, runId)) throw new Error(`Run ${runId} not found`);
  const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
  const run = await workflow.createRun({ runId });
  await run.resume({ step: awaitQaVerdictStep, resumeData: verdict, requestContext });
  const updated = await runRepository.get(owner, runId);
  if (!updated) throw new Error(`Run ${runId} not found after workflow resume`);
  return updated;
}

export async function cancelE2ERun(mastra: Mastra, owner: OwnerScope, runId: string): Promise<E2ERun> {
  const current = await runRepository.get(owner, runId);
  if (!current) throw new Error(`Run ${runId} not found`);
  const workflow = mastra.getWorkflow("qasey-e2e-lifecycle");
  const run = await workflow.createRun({ runId });
  await run.cancel();
  const cancelled = await e2eCoordinator.cancel(owner, runId);
  const changeSet = await caseHubRepository.getChangeSet(owner, current.changeSetId);
  if (changeSet && !["merged", "failed", "cancelled", "abandoned"].includes(changeSet.status)) {
    await caseHubRepository.updateChangeSet(owner, changeSet.id, changeSet.revision, { status: "cancelled" });
  }
  return cancelled;
}

async function failChangeSet(owner: OwnerScope, runId: string, error: unknown): Promise<void> {
  const run = await runRepository.get(owner, runId);
  if (!run) return;
  const changeSet = await caseHubRepository.getChangeSet(owner, run.changeSetId);
  if (!changeSet || ["merged", "failed", "cancelled", "abandoned", "blocked_product", "blocked_environment"].includes(changeSet.status)) return;
  await caseHubRepository.updateChangeSet(owner, changeSet.id, changeSet.revision, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
}

async function playwrightObservations(owner: OwnerScope, artifacts: ArtifactRef[], expectedCaseIds: string[]): Promise<CaseExecutionObservation[]> {
  const latestReports = new Map<string, ArtifactRef>();
  for (const artifact of artifacts) {
    if (artifact.kind === "report" && artifact.name.endsWith("-results.json")) latestReports.set(artifact.name, artifact);
  }
  const observed = new Map<string, CaseExecutionObservation>();
  for (const report of latestReports.values()) {
    const opened = await artifactStore.open(owner, report);
    const payload = JSON.parse(await new Response(opened.body).text()) as unknown;
    collectPlaywrightSuites(payload, observed);
  }
  return expectedCaseIds.map(caseId => observed.get(caseId) ?? { caseId, executionStatus: "blocked" });
}

function collectPlaywrightSuites(payload: unknown, observed: Map<string, CaseExecutionObservation>): void {
  if (!payload || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.specs)) {
    for (const spec of record.specs) {
      if (!spec || typeof spec !== "object") continue;
      const specRecord = spec as Record<string, unknown>;
      const tests = Array.isArray(specRecord.tests) ? specRecord.tests : [];
      for (const test of tests) collectPlaywrightTest(test, String(specRecord.title ?? ""), observed);
    }
  }
  if (Array.isArray(record.suites)) for (const suite of record.suites) collectPlaywrightSuites(suite, observed);
}

function collectPlaywrightTest(test: unknown, fallbackTitle: string, observed: Map<string, CaseExecutionObservation>): void {
  if (!test || typeof test !== "object") return;
  const record = test as Record<string, unknown>;
  const annotations = Array.isArray(record.annotations) ? record.annotations : [];
  const annotatedCase = annotations.find(annotation => annotation && typeof annotation === "object" && (annotation as Record<string, unknown>).type === "qasey.case");
  const description = annotatedCase && typeof annotatedCase === "object" ? (annotatedCase as Record<string, unknown>).description : undefined;
  const caseId = typeof description === "string" ? description : `${String(record.title ?? "")} ${fallbackTitle}`.match(/QASEY-\d+/u)?.[0];
  if (!caseId) return;
  const results = Array.isArray(record.results) ? record.results.filter(result => result && typeof result === "object") as Record<string, unknown>[] : [];
  const statuses = results.map(result => String(result.status ?? ""));
  const executionStatus: CaseExecutionObservation["executionStatus"] = statuses.some(status => ["failed", "timedOut", "interrupted"].includes(status))
    ? "failed"
    : statuses.length > 0 && statuses.every(status => status === "skipped") ? "skipped" : "passed";
  const durationMs = results.reduce((total, result) => total + (typeof result.duration === "number" ? result.duration : 0), 0);
  const previous = observed.get(caseId);
  if (!previous || executionRank(executionStatus) > executionRank(previous.executionStatus)) {
    observed.set(caseId, { caseId, executionStatus, durationMs });
  }
}

function executionRank(status: CaseExecutionObservation["executionStatus"]): number {
  return status === "failed" ? 3 : status === "blocked" ? 2 : status === "skipped" ? 1 : 0;
}
