import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installRuntimeLifecycle, ReadinessRegistry } from "../../src/platform/storage/readiness.ts";

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

  it("times out each dependency check independently", async () => {
    vi.useFakeTimers();
    try {
      const readiness = new ReadinessRegistry({ checkTimeoutMs: 100 });
      readiness.register("blocked", () => new Promise(() => undefined));
      readiness.register("database", async () => undefined);
      readiness.markInitializationComplete();

      const inspection = readiness.inspect();
      await vi.advanceTimersByTimeAsync(100);

      await expect(inspection).resolves.toEqual({
        ready: false,
        dependencies: { blocked: "not_ready", database: "ready" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("becomes not ready immediately when draining, including an in-flight probe", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const readiness = new ReadinessRegistry();
    readiness.register("database", () => blocked);
    readiness.markInitializationComplete();

    const inFlight = readiness.inspect();
    readiness.markDraining();
    release();

    await expect(inFlight).resolves.toEqual({ ready: false, dependencies: {} });
    await expect(readiness.inspect()).resolves.toEqual({ ready: false, dependencies: {} });
  });

  it("extends the generated API shutdown without replacing its signal handler", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const readiness = new ReadinessRegistry();
    readiness.markInitializationComplete();
    const target = {
      shutdown: vi.fn(async () => { events.push("mastra-shutdown"); }),
      stopWorkers: vi.fn(async () => { events.push("mastra-stop-workers"); }),
    };
    const dispose = installRuntimeLifecycle({
      target,
      role: "api",
      readiness: { markDraining: () => {
        events.push("unready");
        readiness.markDraining();
      } },
      closeRuntime: vi.fn(async () => { events.push("close-runtime"); }),
      signals,
    });

    const generatedSignalHandler = vi.fn(async () => target.shutdown());
    signals.on("SIGTERM", generatedSignalHandler);
    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(generatedSignalHandler).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(events).toEqual(["unready", "mastra-shutdown", "close-runtime"]));

    await expect(readiness.inspect()).resolves.toEqual({ ready: false, dependencies: {} });
    expect(target.stopWorkers).not.toHaveBeenCalled();
    dispose();
  });

  it("bounds a stuck Worker drain and still attempts owned-resource cleanup", async () => {
    vi.useFakeTimers();
    try {
      const signals = new EventEmitter();
      const closeRuntime = vi.fn(async () => undefined);
      const target = {
        shutdown: vi.fn(async () => undefined),
        stopWorkers: vi.fn(() => new Promise<void>(() => undefined)),
      };
      const dispose = installRuntimeLifecycle({
        target,
        role: "worker",
        readiness: { markDraining: vi.fn() },
        closeRuntime,
        signals,
        drainTimeoutMs: 100,
        closeTimeoutMs: 50,
      });

      signals.emit("SIGTERM");
      const shutdown = target.stopWorkers();
      const rejection = expect(shutdown).rejects.toThrow(/Mastra drain exceeded 100ms/u);
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(closeRuntime).toHaveBeenCalledOnce();
      dispose();
    } finally {
      vi.useRealTimers();
    }
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
