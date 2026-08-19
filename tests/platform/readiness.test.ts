import { describe, expect, it, vi } from "vitest";
import { ReadinessRegistry } from "../../src/platform/storage/readiness.ts";

describe("runtime readiness", () => {
  it("stays not ready until initialization is explicitly completed", async () => {
    const readiness = new ReadinessRegistry();
    readiness.register("database", vi.fn(async () => undefined));

    await expect(readiness.inspect()).resolves.toEqual({ ready: false, dependencies: {} });

    readiness.markInitializationComplete();
    await expect(readiness.inspect()).resolves.toEqual({
      ready: true,
      dependencies: { database: "ready" },
    });
  });

  it("reports dependency failures without exposing internal error details", async () => {
    const readiness = new ReadinessRegistry();
    readiness.register("database", async () => { throw new Error("secret connection string"); });
    readiness.register("local-store", async () => undefined);
    readiness.markInitializationComplete();

    await expect(readiness.inspect()).resolves.toEqual({
      ready: false,
      dependencies: { database: "not_ready", "local-store": "ready" },
    });
  });

  it("returns to not-ready while a hot-reloaded runtime initializes", async () => {
    const readiness = new ReadinessRegistry();
    readiness.register("database", async () => undefined);
    readiness.markInitializationComplete();
    expect((await readiness.inspect()).ready).toBe(true);

    readiness.markInitializationStarted();
    readiness.register("database", async () => undefined);
    await expect(readiness.inspect()).resolves.toEqual({ ready: false, dependencies: {} });
  });

  it("coalesces concurrent probes and caches their result briefly", async () => {
    let now = 1_000;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const check = vi.fn(() => blocked);
    const readiness = new ReadinessRegistry({ cacheTtlMs: 2_000, now: () => now });
    readiness.register("database", check);
    readiness.markInitializationComplete();

    const first = readiness.inspect();
    const concurrent = readiness.inspect();
    expect(check).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { ready: true, dependencies: { database: "ready" } },
      { ready: true, dependencies: { database: "ready" } },
    ]);

    await readiness.inspect();
    expect(check).toHaveBeenCalledTimes(1);
    now += 2_001;
    await readiness.inspect();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
