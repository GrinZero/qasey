import { randomUUID } from "node:crypto";
import type {
  ArtifactRef,
  CodeTaskEvent,
  CodeTaskEventPage,
  CodeTaskResult,
  CodeTaskSpec,
  CodeTaskState,
} from "../../contracts/src/index.ts";

export interface TaskHandle {
  taskId: string;
  attemptId: string;
  status: CodeTaskState["status"];
}

export interface CodeTaskSecrets {
  environment?: {
    QASEY_E2E_BASE_URL?: string;
    QASEY_E2E_SESSION_TOKEN?: string;
  };
}

export interface CodeTaskRunner {
  submit(spec: CodeTaskSpec, secrets?: CodeTaskSecrets): Promise<TaskHandle>;
  get(taskId: string): Promise<CodeTaskState>;
  events(taskId: string, after?: string): Promise<CodeTaskEventPage>;
  cancel(taskId: string, reason: string): Promise<void>;
  artifact(ref: ArtifactRef): Promise<Buffer>;
}

export interface CodeTaskRunnerProvider {
  forScope(scope: CodeTaskSpec["scope"]): Promise<CodeTaskRunner>;
}

export interface WaitForCodeTaskOptions {
  signal?: AbortSignal;
  pollMs?: number;
  deadlineMs?: number;
  onEvents?: (events: CodeTaskEvent[]) => Promise<void> | void;
  onHeartbeat?: () => Promise<void> | void;
  lostRetries?: number;
  secrets?: CodeTaskSecrets;
}

export async function waitForCodeTask(
  runner: CodeTaskRunner,
  taskId: string,
  options: WaitForCodeTaskOptions = {},
): Promise<CodeTaskResult> {
  const deadline = Date.now() + (options.deadlineMs ?? 30 * 60_000);
  let cursor: string | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    const page = await runner.events(taskId, cursor);
    cursor = page.nextCursor ?? cursor;
    const state = await runner.get(taskId);
    if (state.result) return state.result;
    if (["failed", "cancelled", "lost"].includes(state.status)) {
      throw new Error(state.error ?? `Code task ${taskId} ended in ${state.status}`);
    }
    if (Date.now() >= deadline) {
      await runner.cancel(taskId, "Control-plane deadline exceeded").catch(() => undefined);
      throw new Error(`Code task ${taskId} exceeded its deadline`);
    }
    await options.onHeartbeat?.();
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 500));
  }
}

export async function submitAndWaitForCodeTask(
  runner: CodeTaskRunner,
  spec: CodeTaskSpec,
  options: WaitForCodeTaskOptions = {},
): Promise<{ result: CodeTaskResult; spec: CodeTaskSpec }> {
  let current = spec;
  const retries = options.lostRetries ?? 1;
  for (let recovery = 0; recovery <= retries; recovery += 1) {
    await runner.submit(current, options.secrets);
    try {
      return { result: await waitForCodeTaskWithEvents(runner, current.taskId, options), spec: current };
    } catch (error) {
      const state = await runner.get(current.taskId).catch(() => undefined);
      if (state?.status !== "lost" || recovery === retries) throw error;
      current = { ...current, attemptId: `${spec.attemptId}-recovery-${recovery + 1}-${randomUUID()}` };
    }
  }
  throw new Error(`Code task ${spec.taskId} exhausted recovery attempts`);
}

async function waitForCodeTaskWithEvents(
  runner: CodeTaskRunner,
  taskId: string,
  options: WaitForCodeTaskOptions,
): Promise<CodeTaskResult> {
  const deadline = Date.now() + (options.deadlineMs ?? 30 * 60_000);
  let cursor: string | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    const page = await runner.events(taskId, cursor);
    if (page.events.length) await options.onEvents?.(page.events);
    cursor = page.nextCursor ?? cursor;
    const state = await runner.get(taskId);
    if (state.result) return state.result;
    if (["failed", "cancelled", "lost"].includes(state.status)) {
      throw new Error(state.error ?? `Code task ${taskId} ended in ${state.status}`);
    }
    if (Date.now() >= deadline) {
      await runner.cancel(taskId, "Control-plane deadline exceeded").catch(() => undefined);
      throw new Error(`Code task ${taskId} exceeded its deadline`);
    }
    await options.onHeartbeat?.();
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 500));
  }
}
