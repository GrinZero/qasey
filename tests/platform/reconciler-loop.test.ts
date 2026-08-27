import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconcilerLoop } from "../../src/platform/recovery/reconciler-loop.ts";

afterEach(() => vi.useRealTimers());

describe("reconciler loop", () => {
  it("runs immediately, never overlaps, and drains on close", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const operation = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const loop = new ReconcilerLoop(operation, 5_000).start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(operation).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(operation).toHaveBeenCalledTimes(2);
    release?.();
    await loop.close();
  });

  it("surfaces the most recent failure until a successful pass", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    const loop = new ReconcilerLoop(operation, 5_000, onError).start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(loop.healthCheck()).rejects.toThrow("database unavailable");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(loop.healthCheck()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    await loop.close();
  });
});
