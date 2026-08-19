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
} from "../../packages/contracts/src/index.ts";
import { config, e2eCoordinator, runRepository } from "./runtime.ts";
import { ownerScopeFromRequestContext } from "../platform/context/owner-scope.ts";
import { PlatformRequestContextSchema } from "../platform/context/schema.ts";

const WorkflowInputSchema = z.object({
  runId: z.string().min(1),
  qaFeedback: z.string().min(1).optional(),
});
const WorkflowOutputSchema = z.object({
  runId: z.string().min(1),
  status: RunStatusSchema,
});

const authorAndPersistPatch = createStep({
  id: "author-and-persist-patch",
  description: "Author E2E code, run bounded repairs, validate changed paths, and persist the patch.",
  inputSchema: WorkflowInputSchema,
  outputSchema: z.object({ runId: z.string().min(1) }),
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext }) => {
    const owner = ownerScopeFromRequestContext(requestContext);
    try {
      await e2eCoordinator.authorAndPersistPatch(owner, inputData.runId, inputData.qaFeedback);
    } catch (error) {
      await e2eCoordinator.fail(owner, inputData.runId, error);
      throw error;
    }
    return { runId: inputData.runId };
  },
});

const cleanVerifyAndPublish = createStep({
  id: "clean-verify-and-publish",
  description: "Apply the persisted patch in a fresh workspace, verify it, and publish a Draft PR.",
  inputSchema: z.object({ runId: z.string().min(1) }),
  outputSchema: z.object({ runId: z.string().min(1) }),
  requestContextSchema: PlatformRequestContextSchema,
  execute: async ({ inputData, requestContext }) => {
    const owner = ownerScopeFromRequestContext(requestContext);
    try {
      await e2eCoordinator.cleanVerifyAndPublish(owner, inputData.runId);
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
  description: "Suspend after clean verification until QA approves or requests a bounded repair.",
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
  description: "Durable E2E authoring, clean verification, and QA approval lifecycle.",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowOutputSchema,
  requestContextSchema: PlatformRequestContextSchema,
})
  .then(authorAndPersistPatch)
  .then(cleanVerifyAndPublish)
  .then(awaitQaVerdictStep)
  .commit();

export async function createAndStartE2ERun(
  mastra: Mastra,
  owner: OwnerScope,
  input: CreateE2ERun,
  requestContext: RequestContext,
  resourceId?: string,
): Promise<E2ERun> {
  const created = await e2eCoordinator.create(owner, input);
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
