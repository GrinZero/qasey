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
  environment?: Readonly<Record<string, string>>;
}

export interface CodeTaskRunner {
  submit(spec: CodeTaskSpec, secrets?: CodeTaskSecrets): Promise<TaskHandle>;
  get(taskId: string): Promise<CodeTaskState>;
  events(taskId: string, after?: string): Promise<CodeTaskEventPage>;
  cancel(taskId: string, reason: string): Promise<void>;
  /**
   * Acknowledge that every durable artifact needed by the control plane has
   * been copied out of the execution sandbox. Implementations may now remove
   * every local attempt belonging to this logical task.
   */
  release(taskId: string): Promise<void>;
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
  return waitForCodeTaskWithEvents(runner, taskId, options);
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
  const delivered = new Set<string>();
  let completionDelivered = false;
  async function deliverPage(): Promise<number> {
    const page = await runner.events(taskId, cursor);
    const events = page.events.filter(event => {
      if (delivered.has(event.cursor)) return false;
      delivered.add(event.cursor);
      return true;
    });
    if (events.length) await options.onEvents?.(events);
    completionDelivered ||= events.some(event => event.type === "task.completed");
    cursor = page.nextCursor ?? cursor;
    return events.length;
  }
  async function drainTerminalEvents(): Promise<void> {
    if (!options.onEvents) return;
    // The worker writes terminal state before appending task.completed. Read
    // again even if the pre-state page was empty, and allow that append to land.
    // Both a time budget and page cap bound missing markers or broken cursors.
    const drainDeadline = Date.now() + 1_000;
    for (let page = 0; page < 20 && !completionDelivered; page += 1) {
      options.signal?.throwIfAborted();
      const count = await deliverPage();
      if (completionDelivered || Date.now() >= drainDeadline) break;
      if (!count) await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  while (true) {
    options.signal?.throwIfAborted();
    await deliverPage();
    const state = await runner.get(taskId);
    const terminal = ["failed", "cancelled", "lost"].includes(state.status);
    if (state.result || terminal) await drainTerminalEvents();
    if (state.result) return state.result;
    if (terminal) {
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
