import { describe, expect, it, vi } from "vitest";
import type { CodeTaskEvent, CodeTaskResult, CodeTaskSpec, CodeTaskState } from "../../packages/contracts/src/index.ts";
import { executionProfile, submitAndWaitForCodeTask, waitForCodeTask, type CodeTaskRunner } from "../../packages/code-task/src/index.ts";

describe("generic CodeTask runner", () => {
  it.each(["submit", "wait"])("%s delivers completion appended after terminal state, without replaying overlapping events", async mode => {
    const started = taskEvent("1", "agent.started");
    const finished = taskEvent("2", "agent.completed");
    const completed = taskEvent("3", "task.completed");
    const journal = [started];
    const received: CodeTaskEvent[] = [];
    const runner = terminalRunner();
    // Reproduce the worker ordering: persist result, then asynchronously append
    // the final trace and completion records after the first drain read.
    runner.get = vi.fn(async () => {
      setTimeout(() => journal.push(finished, completed), 5);
      return terminalState();
    });
    runner.events = vi.fn(async (_taskId, after) => ({
      // Deliberately overlap the cursor boundary, as a replaying transport can.
      events: journal.filter(event => !after || Number(event.cursor) >= Number(after)),
      nextCursor: journal.at(-1)?.cursor,
    }));
    const options = { onEvents: (events: CodeTaskEvent[]) => { received.push(...events); } };
    const result = mode === "submit"
      ? (await submitAndWaitForCodeTask(runner, reviewSpec(), options)).result
      : await waitForCodeTask(runner, "review-1", options);

    expect(result.status).toBe("succeeded");
    expect(received.map(event => event.type)).toEqual(["agent.started", "agent.completed", "task.completed"]);
    expect(runner.get).toHaveBeenCalledTimes(1);
    expect(runner.events).toHaveBeenCalledWith("review-1", "1");
  });

  it("bounds terminal draining when a transport repeats the same page without a completion marker", async () => {
    vi.useFakeTimers();
    try {
      const runner = terminalRunner();
      runner.events = vi.fn(async () => ({ events: [taskEvent("1", "agent.started")], nextCursor: "1" }));
      const onEvents = vi.fn();
      const pending = submitAndWaitForCodeTask(runner, reviewSpec(), { onEvents });
      await vi.runAllTimersAsync();
      expect((await pending).result.status).toBe("succeeded");
      expect(runner.events).toHaveBeenCalledTimes(21);
      expect(onEvents).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains paginated terminal evidence before releasing the result", async () => {
    const runner = terminalRunner();
    const journal = [taskEvent("1", "agent.completed"), taskEvent("2", "check.completed"), taskEvent("3", "task.completed")];
    runner.events = vi.fn(async (_taskId, after) => {
      const events = journal.filter(event => Number(event.cursor) > Number(after ?? 0)).slice(0, 1);
      return { events, nextCursor: events.at(-1)?.cursor };
    });
    const received: CodeTaskEvent[] = [];
    await submitAndWaitForCodeTask(runner, reviewSpec(), { onEvents: events => { received.push(...events); } });
    expect(received).toEqual(journal);
    expect(runner.events).toHaveBeenCalledTimes(3);
  });

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
      release: vi.fn(async () => undefined),
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
      release: vi.fn(async () => undefined),
      artifact: vi.fn(async () => Buffer.alloc(0)),
    };

    await submitAndWaitForCodeTask(runner, reviewSpec(), { pollMs: 1, onHeartbeat: heartbeat });

    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});

function taskEvent(cursor: string, type: string): CodeTaskEvent {
  return { cursor, type, taskId: "review-1", at: new Date().toISOString(), message: type, metadata: {} };
}

function terminalState(): CodeTaskState {
  const now = new Date().toISOString();
  return { taskId: "review-1", attemptId: "attempt-1", status: "succeeded", createdAt: now, updatedAt: now, result: successfulResult() };
}

function terminalRunner(): CodeTaskRunner {
  return {
    submit: vi.fn(async spec => ({ taskId: spec.taskId, attemptId: spec.attemptId, status: "queued" as const })),
    get: vi.fn(async () => terminalState()),
    events: vi.fn(async () => ({ events: [] })),
    cancel: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    artifact: vi.fn(async () => Buffer.alloc(0)),
  };
}

function reviewSpec(): CodeTaskSpec {
  return {
    taskId: "review-1", attemptId: "attempt-1", kind: "review",
    scope: { applicationId: "qasey", tenantId: "tenant", sessionId: "session" },
    contextRef: { id: "context", kind: "report", name: "context.json", uri: "file:///context.json" },
    contextHash: "a".repeat(64),
    repositories: [{ owner: "example-org", repository: "web-app", destination: "target", mode: "read", baseRef: "main", baseSha: "b".repeat(40) }],
    baseSha: "b".repeat(40), executionProfileId: "code-review-readonly", allowedPaths: [], fixedChecks: [], e2eRequiredEnvironment: [], deadlineMs: 60_000,
    traceContext: { traceId: "trace-1" },
  };
}

function successfulResult(): CodeTaskResult {
  return {
    status: "succeeded", summary: "reviewed", changedPaths: [], changes: [], checks: [], artifacts: [],
    provenance: { imageDigest: "sha256:test", profileHash: "c".repeat(64), agentBackend: "native-mastra", mastraVersion: "1.64.0", model: "gpt-5.6-sol" },
  };
}
