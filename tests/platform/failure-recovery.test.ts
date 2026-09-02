import { describe, expect, it, vi } from "vitest";
import type { E2ERun, OwnerScope } from "../../packages/contracts/src/index.ts";
import { freezeE2EContext, InMemoryRunRepository } from "../../packages/domain/src/index.ts";
import {
  FailureRedriveService,
  InMemoryFailureInboxStore,
  StaleRunReconciler,
} from "../../src/platform/recovery/failure-inbox.ts";

const owner: OwnerScope = { applicationId: "qasey", tenantId: "tenant-a" };

describe("workflow failure recovery", () => {
  it("moves stale active runs to one idempotent failure inbox entry", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    const runs = new InMemoryRunRepository(() => now);
    const failures = new InMemoryFailureInboxStore(() => now);
    const run = fixtureRun(owner, "run-1");
    await runs.create(owner, run);
    now = new Date("2026-08-26T00:31:00.000Z");
    const reconciler = new StaleRunReconciler(runs, failures, 30 * 60_000);

    await expect(reconciler.runOnce(now)).resolves.toEqual({ inspected: 1, failed: 1, conflicted: 0 });
    expect((await runs.get(owner, run.id))?.status).toBe("failed");
    const inbox = await failures.list(owner);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ runId: run.id, reasonCode: "heartbeat_timeout", status: "pending" });
    await failures.record({ ...owner, runId: run.id, workflowId: "qasey-e2e-lifecycle", reasonCode: "heartbeat_timeout", errorCode: "same", message: "same" });
    await expect(failures.list(owner)).resolves.toHaveLength(1);
  });

  it("does not classify waiting-for-QA runs as stuck", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    const runs = new InMemoryRunRepository(() => now);
    const failures = new InMemoryFailureInboxStore(() => now);
    const run = { ...fixtureRun(owner, "run-qa"), status: "awaiting_qa" as const };
    await runs.create(owner, run);
    now = new Date("2026-08-27T00:00:00.000Z");

    await expect(new StaleRunReconciler(runs, failures, 30 * 60_000).runOnce(now))
      .resolves.toEqual({ inspected: 0, failed: 0, conflicted: 0 });
  });

  it("redrives only an owner-scoped failed run and writes an audit receipt", async () => {
    let now = new Date("2026-08-26T00:31:00.000Z");
    const runs = new InMemoryRunRepository(() => now);
    const failures = new InMemoryFailureInboxStore(() => now);
    const failed = { ...fixtureRun(owner, "run-failed"), status: "failed" as const, error: "timeout" };
    await runs.create(owner, failed);
    const failure = await failures.record({
      ...owner, runId: failed.id, workflowId: "qasey-e2e-lifecycle", reasonCode: "heartbeat_timeout",
      errorCode: "RUN_HEARTBEAT_TIMEOUT", message: "timeout",
    });
    const audit = { write: vi.fn(async () => undefined) };
    const createRedrive = vi.fn(async (_owner: OwnerScope) => fixtureRun(owner, "run-redrive"));
    const service = new FailureRedriveService(failures, runs, createRedrive, audit, () => now);

    const completed = await service.redrive({ owner, failureId: failure.id, expectedRevision: 1, actorId: "operator-a", requestId: "request-1" });

    expect(completed).toMatchObject({ status: "redriven", attempts: 1, redriveRunId: "run-redrive" });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: "redrive", decision: "allow" }));
    await expect(failures.get({ ...owner, tenantId: "tenant-b" }, failure.id)).resolves.toBeUndefined();
  });

  it("returns failed redrives to a bounded retry schedule", async () => {
    const now = new Date("2026-08-26T00:31:00.000Z");
    const runs = new InMemoryRunRepository(() => now);
    const failures = new InMemoryFailureInboxStore(() => now);
    const failed = { ...fixtureRun(owner, "run-failed"), status: "failed" as const, error: "timeout" };
    await runs.create(owner, failed);
    const failure = await failures.record({
      ...owner, runId: failed.id, workflowId: "qasey-e2e-lifecycle", reasonCode: "heartbeat_timeout",
      errorCode: "RUN_HEARTBEAT_TIMEOUT", message: "timeout", maxAttempts: 2,
    });
    const service = new FailureRedriveService(
      failures, runs, async () => { throw new Error("worker unavailable token=do-not-leak"); },
      { write: vi.fn(async () => undefined) }, () => now,
    );

    await expect(service.redrive({ owner, failureId: failure.id, expectedRevision: 1, actorId: "operator", requestId: "request" }))
      .rejects.toThrow("worker unavailable");
    const pending = await failures.get(owner, failure.id);
    expect(pending).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: "2026-08-26T00:31:30.000Z" });
    expect(pending?.message).not.toContain("do-not-leak");
  });
});

function fixtureRun(scope: OwnerScope, id: string): E2ERun {
  const createdAt = "2026-08-26T00:00:00.000Z";
  const contextSnapshot = freezeE2EContext({
    goal: "test", requirementSummary: "test", inScope: [], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [],
    criticalFlows: [], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
  }, { sessionId: "session", threadId: "thread", taskRunId: "task", requestId: "request", resourceId: "resource" });
  return {
    ...scope, id, requestId: "request", sourceSessionId: "session", status: "queued", revision: 1,
    platform: "web", framework: "playwright", repository: {
      owner: "example", repository: "web", cloneUrl: "https://github.com/example/web.git", baseRef: "main", allowedPaths: ["tests"], skillsPaths: [],
    },
    changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff", contextSnapshot, caseSnapshot: [], amendments: [], codeTaskIds: [], artifacts: [], createdAt, updatedAt: createdAt,
  };
}
