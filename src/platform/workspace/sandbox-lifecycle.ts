import type { WorkspaceSandbox } from "@mastra/core/workspace";

export class SubjectSandboxCache {
  private readonly entries = new Map<string, { sandbox: WorkspaceSandbox; touchedAt: number }>();
  constructor(private readonly capacity = 32, private readonly idleTtlMs = 15 * 60_000) {}

  async get(key: string, create: () => Promise<WorkspaceSandbox>): Promise<WorkspaceSandbox> {
    await this.evictIdle();
    const existing = this.entries.get(key);
    if (existing) { existing.touchedAt = Date.now(); return existing.sandbox; }
    const sandbox = await create();
    this.entries.set(key, { sandbox, touchedAt: Date.now() });
    await this.evictCapacity();
    return sandbox;
  }

  async close(): Promise<void> {
    const values = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(values.map(entry => entry.sandbox.destroy?.()));
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [key, entry] of this.entries) {
      if (entry.touchedAt > cutoff) continue;
      this.entries.delete(key);
      await entry.sandbox.destroy?.();
    }
  }

  private async evictCapacity(): Promise<void> {
    while (this.entries.size > this.capacity) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      await oldest[1].sandbox.destroy?.();
    }
  }
}
