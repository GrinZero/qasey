export interface ReadinessSnapshot {
  ready: boolean;
  dependencies: Record<string, "ready" | "not_ready">;
}

type HealthCheck = () => Promise<void>;

export class ReadinessRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  private initializationComplete = false;

  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  markInitializationStarted(): void {
    this.initializationComplete = false;
  }

  markInitializationComplete(): void {
    this.initializationComplete = true;
  }

  async inspect(): Promise<ReadinessSnapshot> {
    if (!this.initializationComplete) return { ready: false, dependencies: {} };
    const results = await Promise.all([...this.checks].map(async ([name, check]) => {
      try {
        await check();
        return [name, "ready"] as const;
      } catch {
        return [name, "not_ready"] as const;
      }
    }));
    const dependencies = Object.fromEntries(results);
    return {
      ready: Object.values(dependencies).every(status => status === "ready"),
      dependencies,
    };
  }
}

export const runtimeReadiness = new ReadinessRegistry();
