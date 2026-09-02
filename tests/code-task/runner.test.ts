import { describe, expect, it, vi } from "vitest";
import type { CodeTaskResult, CodeTaskSpec, CodeTaskState } from "../../packages/contracts/src/index.ts";
import { executionProfile, submitAndWaitForCodeTask, type CodeTaskRunner } from "../../packages/code-task/src/index.ts";

describe("generic CodeTask runner", () => {
  it("recreates a lost attempt from the same frozen context and pinned base", async () => {
    const attempts: CodeTaskSpec[] = [];
    let state: CodeTaskState | undefined;
    const result = successfulResult();
    const runner: CodeTaskRunner = {
      submit: vi.fn(async spec => {
        attempts.push(spec);
        const now = new Date().toISOString();
        state = attempts.length === 1
          ? { taskId: spec.taskId, attemptId: spec.attemptId, status: "lost", createdAt: now, updatedAt: now, error: "sandbox restarted" }
          : { taskId: spec.taskId, attemptId: spec.attemptId, status: "succeeded", createdAt: now, updatedAt: now, result };
        return { taskId: spec.taskId, attemptId: spec.attemptId, status: state.status };
      }),
      get: vi.fn(async () => state!),
      events: vi.fn(async () => ({ events: [] })),
      cancel: vi.fn(async () => undefined),
      artifact: vi.fn(async () => Buffer.alloc(0)),
    };

    const spec = reviewSpec();
    const completed = await submitAndWaitForCodeTask(runner, spec, { pollMs: 1, lostRetries: 1 });

    expect(completed.result.status).toBe("succeeded");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ taskId: spec.taskId, contextHash: spec.contextHash, baseSha: spec.baseSha });
    expect(attempts[1]!.attemptId).not.toBe(spec.attemptId);
  });

  it("keeps readonly review free of Playwright and writable-path semantics", () => {
    const profile = executionProfile("code-review-readonly");
    const spec = reviewSpec();
    expect(profile).toMatchObject({ useAgent: true, writable: false, permission: "reject", allowedCheckIds: [] });
    expect(spec).toMatchObject({ kind: "review", executionProfileId: "code-review-readonly", allowedPaths: [], fixedChecks: [] });
  });

  it("emits liveness heartbeats while a non-terminal task is being polled", async () => {
    const heartbeat = vi.fn();
    let polls = 0;
    const result = successfulResult();
    const runner: CodeTaskRunner = {
      submit: vi.fn(async (spec: CodeTaskSpec) => ({ taskId: spec.taskId, attemptId: spec.attemptId, status: "queued" as const })),
      get: vi.fn(async (): Promise<CodeTaskState> => {
        polls += 1;
        const now = new Date().toISOString();
        return polls > 1
          ? { taskId: "review-1", attemptId: "attempt-1", status: "succeeded", createdAt: now, updatedAt: now, result }
          : { taskId: "review-1", attemptId: "attempt-1", status: "running", createdAt: now, updatedAt: now };
      }),
      events: vi.fn(async () => ({ events: [] })),
      cancel: vi.fn(async () => undefined),
      artifact: vi.fn(async () => Buffer.alloc(0)),
    };

    await submitAndWaitForCodeTask(runner, reviewSpec(), { pollMs: 1, onHeartbeat: heartbeat });

    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});

function reviewSpec(): CodeTaskSpec {
  return {
    taskId: "review-1", attemptId: "attempt-1", kind: "review",
    scope: { applicationId: "qasey", tenantId: "tenant", sessionId: "session" },
    contextRef: { id: "context", kind: "report", name: "context.json", uri: "file:///context.json" },
    contextHash: "a".repeat(64),
    repositories: [{ owner: "example-org", repository: "web-app", destination: "target", mode: "read", baseRef: "main", baseSha: "b".repeat(40) }],
    baseSha: "b".repeat(40), executionProfileId: "code-review-readonly", allowedPaths: [], fixedChecks: [], deadlineMs: 60_000,
    traceContext: { traceId: "trace-1" },
  };
}

function successfulResult(): CodeTaskResult {
  return {
    status: "succeeded", summary: "reviewed", changedPaths: [], changes: [], checks: [], artifacts: [],
    provenance: { imageDigest: "sha256:test", profileHash: "c".repeat(64), agentBackend: "native-mastra", mastraVersion: "1.59.0", model: "gpt-5.6-sol" },
  };
}
