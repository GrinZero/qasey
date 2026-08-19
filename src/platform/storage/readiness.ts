export interface ReadinessSnapshot {
  ready: boolean;
  dependencies: Record<string, "ready" | "not_ready">;
}

type HealthCheck = () => Promise<void>;

export interface ReadinessRegistryOptions {
  cacheTtlMs?: number;
  now?: () => number;
}

export class ReadinessRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private initializationComplete = false;
  private generation = 0;
  private cached: { expiresAt: number; snapshot: ReadinessSnapshot } | undefined;
  private pending: Promise<ReadinessSnapshot> | undefined;

  constructor(options: ReadinessRegistryOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
    this.invalidate();
  }

  markInitializationStarted(): void {
    this.initializationComplete = false;
    this.invalidate();
  }

  markInitializationComplete(): void {
    this.initializationComplete = true;
    this.invalidate();
  }

  async inspect(): Promise<ReadinessSnapshot> {
    if (!this.initializationComplete) return { ready: false, dependencies: {} };
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.snapshot;
    if (this.pending) return this.pending;

    const generation = this.generation;
    const pending = Promise.all([...this.checks].map(async ([name, check]) => {
      try {
        await check();
        return [name, "ready"] as const;
      } catch {
        return [name, "not_ready"] as const;
      }
    })).then(results => {
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
}

export const runtimeReadiness = new ReadinessRegistry();
