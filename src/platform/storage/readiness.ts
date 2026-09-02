export interface ReadinessSnapshot {
  ready: boolean;
  dependencies: Record<string, "ready" | "not_ready">;
}

type HealthCheck = () => Promise<void>;

export interface RuntimeLifecycleTarget {
  shutdown(): Promise<void>;
  stopWorkers(): Promise<void>;
}

export interface RuntimeSignalSource {
  prependListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface RuntimeLifecycleOptions {
  closeRuntime: () => Promise<void>;
  closeTimeoutMs?: number;
  drainTimeoutMs?: number;
  readiness: Pick<ReadinessRegistry, "markDraining">;
  role: "api" | "worker";
  signals?: RuntimeSignalSource;
  target: RuntimeLifecycleTarget;
}

export interface ReadinessRegistryOptions {
  cacheTtlMs?: number;
  checkTimeoutMs?: number;
  now?: () => number;
}

export class ReadinessRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  private readonly cacheTtlMs: number;
  private readonly checkTimeoutMs: number;
  private readonly now: () => number;
  private initializationComplete = false;
  private draining = false;
  private generation = 0;
  private cached: { expiresAt: number; snapshot: ReadinessSnapshot } | undefined;
  private pending: Promise<ReadinessSnapshot> | undefined;

  constructor(options: ReadinessRegistryOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 2_000;
    if (this.checkTimeoutMs <= 0) throw new RangeError("Readiness check timeout must be positive");
    this.now = options.now ?? Date.now;
  }

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
    this.invalidate();
  }

  markInitializationStarted(): void {
    this.initializationComplete = false;
    this.draining = false;
    this.invalidate();
  }

  markInitializationComplete(): void {
    this.initializationComplete = true;
    this.invalidate();
  }

  markDraining(): void {
    this.draining = true;
    this.invalidate();
  }

  async inspect(): Promise<ReadinessSnapshot> {
    if (!this.initializationComplete || this.draining) return { ready: false, dependencies: {} };
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.snapshot;
    if (this.pending) return this.pending;

    const generation = this.generation;
    const pending = Promise.all([...this.checks].map(async ([name, check]) => {
      try {
        await this.runCheck(check);
        return [name, "ready"] as const;
      } catch {
        return [name, "not_ready"] as const;
      }
    })).then(results => {
      if (!this.initializationComplete || this.draining || this.generation !== generation) {
        return { ready: false, dependencies: {} } satisfies ReadinessSnapshot;
      }
      const dependencies = Object.fromEntries(results);
      const snapshot = {
        ready: Object.values(dependencies).every(status => status === "ready"),
        dependencies,
      } satisfies ReadinessSnapshot;
      if (this.initializationComplete && this.generation === generation) {
        this.cached = { expiresAt: this.now() + this.cacheTtlMs, snapshot };
      }
      return snapshot;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.pending = undefined;
  }

  private async runCheck(check: HealthCheck): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        check(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Readiness check exceeded ${this.checkTimeoutMs}ms`)),
            this.checkTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const runtimeReadiness = new ReadinessRegistry();

/**
 * Extend, rather than replace, the lifecycle owned by Mastra's generated API
 * and Worker entries. The generated signal handler remains responsible for
 * closing the listener/process; this wrapper makes readiness and Qasey's owned
 * resources part of the native shutdown method it already invokes.
 */
export function installRuntimeLifecycle(options: RuntimeLifecycleOptions): () => void {
  const signals = options.signals ?? process;
  const drainTimeoutMs = options.drainTimeoutMs ?? 3_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 1_500;
  if (drainTimeoutMs <= 0 || closeTimeoutMs <= 0) {
    throw new RangeError("Runtime lifecycle timeouts must be positive");
  }

  let shutdownRequested = false;
  const requestShutdown = () => {
    shutdownRequested = true;
    options.readiness.markDraining();
  };
  signals.prependListener("SIGINT", requestShutdown);
  signals.prependListener("SIGTERM", requestShutdown);

  const method = options.role === "worker" ? "stopWorkers" : "shutdown";
  const original = options.target[method].bind(options.target);
  let shutdown: Promise<void> | undefined;
  const wrapped = (): Promise<void> => {
    if (!shutdownRequested) return original();
    shutdown ??= runRuntimeShutdown(original, options.closeRuntime, drainTimeoutMs, closeTimeoutMs);
    return shutdown;
  };
  options.target[method] = wrapped;

  return () => {
    signals.removeListener("SIGINT", requestShutdown);
    signals.removeListener("SIGTERM", requestShutdown);
    if (options.target[method] === wrapped) options.target[method] = original;
  };
}

async function runRuntimeShutdown(
  drain: () => Promise<void>,
  closeRuntime: () => Promise<void>,
  drainTimeoutMs: number,
  closeTimeoutMs: number,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await runWithDeadline(drain, drainTimeoutMs, "Mastra drain");
  } catch (error) {
    errors.push(error);
  }
  // A timed-out drain cannot be cancelled by Mastra. Start best-effort owned
  // resource cleanup at the deadline so the generated entry can still enforce
  // its process-level shutdown bound.
  try {
    await runWithDeadline(closeRuntime, closeTimeoutMs, "Qasey runtime close");
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Runtime shutdown failed");
}

async function runWithDeadline(operation: () => Promise<void>, timeoutMs: number, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
