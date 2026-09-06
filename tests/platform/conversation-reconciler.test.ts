import { describe, expect, it, vi } from "vitest";
import { StaleConversationReconciler } from "../../src/platform/recovery/conversation-reconciler.ts";

describe("stale conversation reconciler", () => {
  it("sweeps turns older than its grace period and reports the recovered count", async () => {
    const failStale = vi.fn().mockResolvedValue(2);
    const reconciler = new StaleConversationReconciler(
      { failStale },
      100 * 60_000,
      () => new Date("2026-09-04T08:00:00.000Z"),
    );

    await expect(reconciler.runOnce()).resolves.toBe(2);
    expect(failStale).toHaveBeenCalledWith(new Date("2026-09-04T06:20:00.000Z"));
  });

  it("rejects a non-positive stale threshold", () => {
    expect(() => new StaleConversationReconciler({ failStale: vi.fn() }, 0)).toThrow(
      "Conversation stale threshold must be positive",
    );
  });
});
