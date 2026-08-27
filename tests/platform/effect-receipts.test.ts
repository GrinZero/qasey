import { describe, expect, it, vi } from "vitest";
import {
  EffectReceiptError,
  InMemoryEffectReceiptStore,
  SideEffectExecutor,
  UnknownSideEffectOutcomeError,
  hashCanonical,
  stableEffectKey,
} from "../../src/platform/recovery/effect-receipts.ts";

const owner = { applicationId: "qasey", tenantId: "tenant-a" };

describe("external side-effect receipts", () => {
  it("returns a persisted result without repeating a completed operation", async () => {
    const store = new InMemoryEffectReceiptStore();
    const executor = new SideEffectExecutor(store);
    const operation = vi.fn(async (key: string) => ({ result: { url: "https://github.com/example/repo/pull/1" }, externalRef: key }));
    const input = {
      owner, runId: "run-1", stepId: "publish-pr", businessKey: "branch-1",
      request: { baseSha: "a".repeat(40), branch: "branch-1" }, operation,
    };

    await expect(executor.execute(input)).resolves.toMatchObject({ url: expect.stringContaining("/pull/1") });
    await expect(executor.execute(input)).resolves.toMatchObject({ url: expect.stringContaining("/pull/1") });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(stableEffectKey(owner, "run-1", "publish-pr", "branch-1"));
  });

  it("allows one concurrent owner and rejects an in-flight duplicate", async () => {
    const store = new InMemoryEffectReceiptStore();
    const requestHash = hashCanonical({ value: 1 });
    const input = { ...owner, idempotencyKey: "key", runId: "run", stepId: "step", requestHash };
    const first = await store.begin(input);
    expect("leaseToken" in first).toBe(true);
    await expect(store.begin(input)).rejects.toMatchObject({ code: "in_progress" });
  });

  it("never automatically retries an ambiguous external outcome", async () => {
    const store = new InMemoryEffectReceiptStore();
    const executor = new SideEffectExecutor(store);
    const input = {
      owner, runId: "run-1", stepId: "publish-pr", businessKey: "branch-1", request: { branch: "branch-1" },
      operation: vi.fn(async () => { throw new UnknownSideEffectOutcomeError("connection closed after request upload"); }),
    };

    await expect(executor.execute(input)).rejects.toBeInstanceOf(UnknownSideEffectOutcomeError);
    await expect(executor.execute(input)).rejects.toBeInstanceOf(EffectReceiptError);
    expect(input.operation).toHaveBeenCalledTimes(1);
  });

  it("recognizes the publisher's structured unknown-outcome code and blocks retry", async () => {
    const store = new InMemoryEffectReceiptStore();
    const executor = new SideEffectExecutor(store);
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("safe publisher error"), { code: "side_effect_outcome_unknown" as const });
    });
    const input = {
      owner, runId: "run-2", stepId: "publish-pr", businessKey: "branch-2", request: { branch: "branch-2" }, operation,
    };

    await expect(executor.execute(input)).rejects.toMatchObject({ code: "side_effect_outcome_unknown" });
    const key = stableEffectKey(owner, "run-2", "publish-pr", "branch-2");
    await expect(store.get(owner, key)).resolves.toMatchObject({ status: "unknown", attempts: 1 });
    await expect(executor.execute(input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not infer an unknown outcome from an error name or message", async () => {
    const store = new InMemoryEffectReceiptStore();
    const executor = new SideEffectExecutor(store);
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("side_effect_outcome_unknown"), { name: "UnknownSideEffectOutcomeError" }))
      .mockResolvedValueOnce({ result: "recovered" });
    const input = {
      owner, runId: "run-3", stepId: "publish-pr", businessKey: "branch-3", request: { branch: "branch-3" }, operation,
    };

    await expect(executor.execute(input)).rejects.toThrow("side_effect_outcome_unknown");
    await expect(executor.execute(input)).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("rejects an idempotency key reused for a different request", async () => {
    const store = new InMemoryEffectReceiptStore();
    const base = { ...owner, idempotencyKey: "same", runId: "run", stepId: "step" };
    await store.begin({ ...base, requestHash: hashCanonical({ value: 1 }) });
    await expect(store.begin({ ...base, requestHash: hashCanonical({ value: 2 }) }))
      .rejects.toMatchObject({ code: "request_mismatch" });
  });
});
