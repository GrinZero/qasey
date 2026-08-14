import { describe, expect, it, vi } from "vitest";
import {
  createCallKey,
  createSourceKey,
  EvidenceLedger,
} from "../../packages/domain/src/index.ts";

describe("EvidenceLedger", () => {
  it("canonicalizes object keys and Figma node id separators", () => {
    expect(createCallKey("figma_get_node_detail", { file_key: "abc", node_ids: "1-2", depth: 2 }))
      .toBe(createCallKey("figma_get_node_detail", { depth: 2, node_ids: "1:2", file_key: "abc" }));
    expect(createSourceKey("slack_get_thread", { channel: "C1", threadTs: "123.45", limit: 100 }))
      .toBe("slack-thread:C1:123.45");
    expect(createCallKey("slack_get_thread", { channel: "C1", threadTs: "123.45" }))
      .toBe(createCallKey("slack_get_thread", { channel: "C1", threadTs: "123.45", limit: 100 }));
  });

  it("single-flights concurrent calls and returns a compact duplicate receipt", async () => {
    const ledger = new EvidenceLedger("run-1");
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const operation = vi.fn(() => pending);

    const first = ledger.execute("slack_get_thread", { channel: "C1", threadTs: "1" }, operation);
    const duplicate = ledger.execute("slack_get_thread", { threadTs: "1", channel: "C1" }, operation);
    release({ messages: ["hello"] });

    await expect(first).resolves.toEqual({ messages: ["hello"] });
    await expect(duplicate).resolves.toMatchObject({ status: "already_acquired", sourceKey: "slack-thread:C1:1" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("deduplicates equivalent calls that resolve to the same source identity", async () => {
    const ledger = new EvidenceLedger("run-source-key");
    const operation = vi.fn(async () => ({ messages: ["one"] }));

    await ledger.execute("slack_get_thread", { channel: "C1", threadTs: "1", limit: 100 }, operation);
    await expect(ledger.execute("slack_get_thread", { channel: "C1", threadTs: "1", limit: 50 }, operation))
      .resolves.toMatchObject({ status: "already_acquired", sourceKey: "slack-thread:C1:1" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an incomplete Slack snapshot for a larger requested limit", async () => {
    const ledger = new EvidenceLedger("run-source-coverage");
    const operation = vi.fn(async () => ({ messages: ["one"] }));

    await ledger.execute("slack_get_thread", { channel: "C1", threadTs: "1", limit: 50 }, operation);
    await ledger.execute("slack_get_thread", { channel: "C1", threadTs: "1", limit: 100 }, operation);
    await ledger.execute("slack_get_thread", { channel: "C1", threadTs: "1", limit: 25 }, operation);

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("stores large results as artifacts and reads bounded chunks", async () => {
    const ledger = new EvidenceLedger("run-2", { maxInlineChars: 20, previewChars: 5, maxArtifactChunkChars: 10 });
    const result = await ledger.execute("github_get_pull_request_diff", {
      owner: "MoeGoLibrary", repo: "api", pullNumber: 1,
    }, async () => "abcdefghijklmnopqrstuvwxyz");

    expect(result).toMatchObject({ status: "acquired", totalChars: 28, preview: "abcde", truncated: true });
    const artifactId = (result as { artifactId: string }).artifactId;
    expect(ledger.readArtifact(artifactId, 0, 10)).toMatchObject({ content: "\"abcdefghi", nextOffset: 10, done: false });
  });

  it("does not retry non-retryable failures and allows one retry for transient failures", async () => {
    const forbiddenLedger = new EvidenceLedger("run-3");
    const forbidden = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    const forbiddenOperation = vi.fn(async () => { throw forbidden; });
    await expect(forbiddenLedger.execute("figma_list_pages", { file_key: "abc" }, forbiddenOperation)).rejects.toThrow("Forbidden");
    await expect(forbiddenLedger.execute("figma_list_pages", { file_key: "abc" }, forbiddenOperation)).resolves.toMatchObject({
      status: "failed", errorCode: "HTTP_403", retryable: false, attempts: 1,
    });
    expect(forbiddenOperation).toHaveBeenCalledTimes(1);

    const transientLedger = new EvidenceLedger("run-4", { maxRetryableAttempts: 2 });
    const transientOperation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("upstream"), { statusCode: 503 }))
      .mockResolvedValueOnce({ ok: true });
    await expect(transientLedger.execute("slack_get_thread", { channel: "C", threadTs: "1" }, transientOperation)).rejects.toThrow("upstream");
    await expect(transientLedger.execute("slack_get_thread", { channel: "C", threadTs: "1" }, transientOperation)).resolves.toEqual({ ok: true });
    expect(transientOperation).toHaveBeenCalledTimes(2);
  });

  it("stops after two tool iterations with no new evidence", async () => {
    const ledger = new EvidenceLedger("run-5");
    const input = { channel: "C", threadTs: "1" };
    await ledger.execute("slack_get_thread", input, async () => ({ ok: true }));
    expect(ledger.finishIteration(1)).toMatchObject({ madeProgress: true, shouldStop: false });

    await ledger.execute("slack_get_thread", input, async () => ({ unreachable: true }));
    expect(ledger.finishIteration(1)).toMatchObject({ madeProgress: false, shouldWarn: true, shouldStop: false });

    await ledger.execute("slack_get_thread", input, async () => ({ unreachable: true }));
    expect(ledger.finishIteration(1)).toMatchObject({ madeProgress: false, shouldStop: true });
  });

  it("does not treat the Code Mode wrapper itself as new external evidence", async () => {
    const ledger = new EvidenceLedger("run-code-mode");
    await ledger.execute("executeTypescript", { code: "return 1" }, async () => ({ value: 1 }));

    expect(ledger.finishIteration(1)).toMatchObject({ madeProgress: false, shouldWarn: true });
  });

  it("requires MeterSphere verification after a successful write", async () => {
    const ledger = new EvidenceLedger("run-6");
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", { cases: [{ name: "case" }] }, async () => ({ ids: ["1"] }));
    expect(ledger.completionReceipt()).toBeUndefined();
    await ledger.execute("metersphere_ms_list_test_cases", { moduleId: "m1" }, async () => ({ cases: [{ id: "1" }] }));
    expect(ledger.completionReceipt()).toMatchObject({
      write: { toolName: "metersphere_ms_bulk_upsert_test_cases" },
      verification: { toolName: "metersphere_ms_list_test_cases" },
    });
  });

  it("does not accept a verification call that started before the write completed", async () => {
    const ledger = new EvidenceLedger("run-7");
    let finishWrite!: (value: unknown) => void;
    let finishRead!: (value: unknown) => void;
    const write = ledger.execute("metersphere_ms_bulk_upsert_test_cases", { cases: [{ name: "case" }] }, () => new Promise(resolve => { finishWrite = resolve; }));
    const read = ledger.execute("metersphere_ms_list_test_cases", { moduleId: "m1" }, () => new Promise(resolve => { finishRead = resolve; }));
    finishWrite({ ids: ["1"] });
    await write;
    finishRead({ cases: [{ id: "1" }] });
    await read;

    expect(ledger.completionReceipt()).toBeUndefined();
  });

  it("invalidates MeterSphere read caches after a write so verification is fresh", async () => {
    const ledger = new EvidenceLedger("run-8");
    const readInput = { moduleId: "m1" };
    const read = vi.fn()
      .mockResolvedValueOnce({ cases: [] })
      .mockResolvedValueOnce({ cases: [{ id: "1" }] });
    await ledger.execute("metersphere_ms_list_test_cases", readInput, read);
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", { cases: [{ name: "case" }] }, async () => ({ ids: ["1"] }));
    await ledger.execute("metersphere_ms_list_test_cases", readInput, read);

    expect(read).toHaveBeenCalledTimes(2);
    expect(ledger.completionReceipt()).toBeDefined();
  });
});
