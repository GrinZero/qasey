export const WORKER_HEARTBEAT_MESSAGE_TYPE = "qasey.worker.heartbeat";
export const WORKER_HEARTBEAT_TOKEN_ENV = "QASEY_INTERNAL_WORKER_HEARTBEAT_TOKEN";
export const WORKER_HEARTBEAT_INTERVAL_ENV = "QASEY_INTERNAL_WORKER_HEARTBEAT_INTERVAL_MS";

export interface WorkerHeartbeatMessage {
  type: typeof WORKER_HEARTBEAT_MESSAGE_TYPE;
  token: string;
  ready: boolean;
}

export interface WorkerHeartbeatHandle {
  close(): Promise<void>;
}

export type WorkerReadinessProbe = () => Promise<{ ready: boolean }>;

/**
 * Publish a fresh, child-owned readiness signal over the private supervisor IPC
 * channel. The generated Worker calls this only after Qasey initialization has
 * completed, so process liveness alone can never make the supervisor ready.
 */
export function startWorkerSupervisorHeartbeat(
  inspect: WorkerReadinessProbe,
  env: NodeJS.ProcessEnv = process.env,
  target: Pick<NodeJS.Process, "connected" | "send"> = process,
): WorkerHeartbeatHandle | undefined {
  const token = env[WORKER_HEARTBEAT_TOKEN_ENV]?.trim();
  if (!token || typeof target.send !== "function") return undefined;
  const intervalMs = positiveInteger(env[WORKER_HEARTBEAT_INTERVAL_ENV], 5_000);
  let closed = false;
  let inspecting = false;

  const publish = (ready: boolean) => {
    if (!target.connected || typeof target.send !== "function") return;
    const message: WorkerHeartbeatMessage = {
      type: WORKER_HEARTBEAT_MESSAGE_TYPE,
      token,
      ready,
    };
    target.send(message, () => undefined);
  };

  const refresh = async () => {
    if (closed || inspecting) return;
    inspecting = true;
    try {
      const snapshot = await inspect();
      if (!closed) publish(snapshot.ready);
    } catch {
      if (!closed) publish(false);
    } finally {
      inspecting = false;
    }
  };

  void refresh();
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref();
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      publish(false);
    },
  };
}

export function isWorkerHeartbeatMessage(value: unknown, token: string): value is WorkerHeartbeatMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerHeartbeatMessage>;
  return candidate.type === WORKER_HEARTBEAT_MESSAGE_TYPE
    && candidate.token === token
    && typeof candidate.ready === "boolean";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
