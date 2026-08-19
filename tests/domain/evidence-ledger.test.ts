import { describe, expect, it, vi } from "vitest";
import {
  createCallKey,
  createSourceKey,
  EvidenceLedger,
} from "../../packages/domain/src/index.ts";

describe("EvidenceLedger", () => {
  const caseItem = (name: string, leaf = "Core", feature = "Feature") => ({
    operation: "create",
    name,
    priority: "P1",
    node_id: `leaf-${leaf}`,
    node_path: `/AI Draft/${feature}/${leaf}`,
  });

  const dryRunResult = (items: Array<ReturnType<typeof caseItem>>) => ({
    content: [{ type: "text", text: JSON.stringify([{
      success: true,
      dry_run: true,
      validated: true,
      item_count: items.length,
      creates: items.map((item, index) => ({
        id: `preview-${index + 1}`,
        name: item.name,
        node_id: item.node_id,
        node_path: item.node_path,
        verified: true,
      })),
    }]) }],
  });

  async function establishPlan(ledger: EvidenceLedger, items: Array<ReturnType<typeof caseItem>>) {
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: true,
      items: JSON.stringify(items),
    }, async () => dryRunResult(items));
    return ledger.casePlan()!;
  }

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
    await expect(forbiddenLedger.execute("figma_list_pages", { file_key: "abc" }, forbiddenOperation)).resolves.toMatchObject({
      status: "failed", errorCode: "HTTP_403", retryable: false, attempts: 1,
    });
    await expect(forbiddenLedger.execute("figma_list_pages", { file_key: "abc" }, forbiddenOperation)).resolves.toMatchObject({
      status: "failed", errorCode: "HTTP_403", retryable: false, attempts: 1,
    });
    expect(forbiddenOperation).toHaveBeenCalledTimes(1);

    const transientLedger = new EvidenceLedger("run-4", { maxRetryableAttempts: 2 });
    const transientOperation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("upstream"), { statusCode: 503 }))
      .mockResolvedValueOnce({ ok: true });
    await expect(transientLedger.execute("slack_get_thread", { channel: "C", threadTs: "1" }, transientOperation)).resolves.toMatchObject({
      status: "failed", errorCode: "HTTP_503", retryable: true, attempts: 1,
    });
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
    const items = [caseItem("case")];
    await establishPlan(ledger, items);
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: false, items: JSON.stringify(items),
    }, async () => ({ content: [{ type: "text", text: JSON.stringify([{
      success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
      results: [{ id: "1", name: "case", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", verified: false, mismatches: ["pending"] }],
    }]) }] }));
    expect(ledger.completionReceipt()).toBeUndefined();
    await ledger.execute("metersphere_ms_list_test_cases", { moduleId: "leaf-Core" }, async () => ({
      cases: [{ id: "1", name: "case", priority: "P1", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", verified: true }],
    }));
    expect(ledger.completionReceipt()).toMatchObject({
      casePlanHash: ledger.casePlan()?.planHash,
      write: { toolName: "metersphere_ms_bulk_upsert_test_cases" },
      verification: { toolName: "metersphere_ms_list_test_cases" },
    });
  });

  it("accepts the bulk tool's verified internal read-back as the completion receipt", async () => {
    const ledger = new EvidenceLedger("run-internal-read-back");
    await ledger.execute("metersphere_ms_upsert_module", {
      name: "FIN-1 Feature 新用例", parent_id: "root",
    }, async () => ({ content: [{ type: "text", text: JSON.stringify([{
      id: "module-root", module_id: "module-root", name: "FIN-1 Feature 新用例",
      path: "/AI Draft/FIN-1 Feature 新用例", verified: true,
    }]) }] }));
    const input = {
      dry_run: false,
      items: JSON.stringify([{
        operation: "create", name: "case", priority: "P0", node_id: "leaf-1",
        node_path: "/AI Draft/FIN-1 Feature 新用例/01 Core",
      }]),
    };
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", { ...input, dry_run: true }, async () => ({
      content: [{ type: "text", text: JSON.stringify([{
        success: true, dry_run: true, validated: true, item_count: 1,
        creates: [{ id: "preview", name: "case", node_id: "leaf-1", node_path: "/AI Draft/FIN-1 Feature 新用例/01 Core", verified: true }],
      }]) }],
    }));
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", input, async () => ({
      content: [{ type: "text", text: JSON.stringify([{
        success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
        results: [{
          id: "case-uuid", num: 123, name: "case", node_id: "leaf-1",
          node_path: "/AI Draft/FIN-1 Feature 新用例/01 Core", verified: true, mismatches: [],
        }],
      }]) }],
    }));

    expect(ledger.completionReceipt()).toMatchObject({
      verificationMode: "internal_read_back",
      caseOperation: {
        moduleId: "module-root",
        featureName: "FIN-1 Feature",
        itemCount: 1,
        verifiedCount: 1,
        cases: [{ priority: "P0" }],
      },
    });
  });

  it("reuses the exact validated bulk payload when the mutation input drifts", async () => {
    const ledger = new EvidenceLedger("run-payload-drift");
    const validatedItems = JSON.stringify([{
      operation: "create", name: "case", node_id: "leaf-8907", node_path: "/AI Draft/Feature/Core",
    }]);
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: true,
      items: validatedItems,
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify([{
        success: true, dry_run: true, validated: true, item_count: 1,
        creates: [{ id: "preview", name: "case", node_path: "/AI Draft/Feature/Core" }],
      }]) }],
    }));
    let executedInput: unknown;
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: false,
      items: validatedItems.replace("leaf-8907", "leaf-8908"),
    }, async effectiveInput => {
      executedInput = effectiveInput;
      return {
        content: [{ type: "text", text: JSON.stringify([{
          success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
          results: [{ id: "case-1", num: 1, name: "case", node_id: "leaf-8907", node_path: "/AI Draft/Feature/Core", verified: true }],
        }]) }],
      };
    });

    expect(JSON.parse((executedInput as { items: string }).items)).toMatchObject([{ node_id: "leaf-8907" }]);
  });

  it("aggregates verified single-case fallbacks into one completion receipt", async () => {
    const ledger = new EvidenceLedger("run-single-fallback");
    await ledger.execute("metersphere_ms_upsert_module", {
      name: "FIN-1 Feature", parent_id: "ai-draft",
    }, async () => ({ content: [{ type: "text", text: JSON.stringify([{
      id: "feature-root", name: "FIN-1 Feature", path: "/AI Draft/FIN-1 Feature", verified: true,
    }]) }] }));
    const items = [caseItem("case one", "Core", "FIN-1 Feature"), caseItem("case two", "Callback", "FIN-1 Feature")];
    await establishPlan(ledger, items);
    for (const [id, name, leaf] of [["case-1", "case one", "Core"], ["case-2", "case two", "Callback"]]) {
      const input = {
        name, node_id: `leaf-${leaf}`, node_path: `/AI Draft/FIN-1 Feature/${leaf}`, priority: "P1",
      };
      await ledger.execute("metersphere_ms_create_test_case", input, async () => ({
        content: [{ type: "text", text: JSON.stringify([{
          id, num: id === "case-1" ? 1 : 2, name, node_id: input.node_id,
          node_path: input.node_path, priority: "P1", verified: true,
        }]) }],
      }));
    }

    expect(ledger.completionReceipt()).toMatchObject({
      verificationMode: "internal_read_back",
      caseOperation: {
        moduleId: "feature-root",
        modulePath: "/AI Draft/FIN-1 Feature",
        itemCount: 2,
        createdCount: 2,
        verifiedCount: 2,
      },
    });
    expect(ledger.completionReceipt()?.caseOperation?.cases.map(testCase => testCase.id)).toEqual(["case-1", "case-2"]);
  });

  it("does not accept a single-case result without explicit read-back verification", async () => {
    const ledger = new EvidenceLedger("run-unverified-single");
    await establishPlan(ledger, [caseItem("case")]);
    await ledger.execute("metersphere_ms_create_test_case", {
      name: "case", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", priority: "P1",
    }, async () => ({
      content: [{ type: "text", text: JSON.stringify([{
        id: "case", num: 1, name: "case", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core",
      }]) }],
    }));

    expect(ledger.completionReceipt()).toBeUndefined();
  });

  it("does not treat a successful dry-run as a MeterSphere write", async () => {
    const ledger = new EvidenceLedger("run-dry-run");
    await establishPlan(ledger, [caseItem("case")]);

    expect(ledger.casePlan()).toMatchObject({ plannedCount: 1, cases: [{ name: "case", order: 1 }] });
    expect(ledger.completionReceipt()).toBeUndefined();
  });

  it("does not accept a verification call that started before the write completed", async () => {
    const ledger = new EvidenceLedger("run-7");
    const items = [caseItem("case")];
    await establishPlan(ledger, items);
    let finishWrite!: (value: unknown) => void;
    let finishRead!: (value: unknown) => void;
    const write = ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: false, items: JSON.stringify(items),
    }, () => new Promise(resolve => { finishWrite = resolve; }));
    const read = ledger.execute("metersphere_ms_list_test_cases", { moduleId: "leaf-Core" }, () => new Promise(resolve => { finishRead = resolve; }));
    finishWrite({ content: [{ type: "text", text: JSON.stringify([{
      success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
      results: [{ id: "1", name: "case", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", verified: false }],
    }]) }] });
    await write;
    finishRead({ cases: [{ id: "1", name: "case", priority: "P1", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", verified: true }] });
    await read;

    expect(ledger.completionReceipt()).toBeUndefined();
  });

  it("invalidates MeterSphere read caches after a write so verification is fresh", async () => {
    const ledger = new EvidenceLedger("run-8");
    const items = [caseItem("case")];
    await establishPlan(ledger, items);
    const readInput = { moduleId: "leaf-Core" };
    const read = vi.fn()
      .mockResolvedValueOnce({ cases: [] })
      .mockResolvedValueOnce({ cases: [{ id: "1", name: "case", priority: "P1", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", verified: true }] });
    await ledger.execute("metersphere_ms_list_test_cases", readInput, read);
    await ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: false, items: JSON.stringify(items),
    }, async () => ({ content: [{ type: "text", text: JSON.stringify([{
      success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
      results: [{ id: "1", name: "case", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", verified: false }],
    }]) }] }));
    await ledger.execute("metersphere_ms_list_test_cases", readInput, read);

    expect(read).toHaveBeenCalledTimes(2);
    expect(ledger.completionReceipt()).toBeDefined();
  });

  it("persists an immutable ordered CasePlan and rejects a changed second plan", async () => {
    const ledger = new EvidenceLedger("run-immutable-plan");
    await ledger.execute("jira_get_issue", { issueKey: "FIN-1" }, async () => ({ summary: "requirement" }));
    const items = [caseItem("first", "Core"), caseItem("second", "Callback")];
    const plan = await establishPlan(ledger, items);

    expect(plan).toMatchObject({
      version: 1,
      plannedCount: 2,
      cases: [
        { name: "first", order: 1, targetModulePath: "/AI Draft/Feature/Core" },
        { name: "second", order: 2, targetModulePath: "/AI Draft/Feature/Callback" },
      ],
      targetModules: [
        { id: "leaf-Core", path: "/AI Draft/Feature/Core" },
        { id: "leaf-Callback", path: "/AI Draft/Feature/Callback" },
      ],
    });
    expect(plan.planHash).toHaveLength(64);
    expect(plan.evidenceSnapshotHash).toHaveLength(64);
    expect(plan.cases.every(testCase => testCase.key.startsWith("case_"))).toBe(true);

    const changed = [caseItem("changed")];
    await expect(ledger.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: true, items: JSON.stringify(changed),
    }, async () => dryRunResult(changed))).resolves.toMatchObject({ status: "failed", retryable: false });
    expect(ledger.casePlan()?.planHash).toBe(plan.planHash);
  });

  it("does not checkpoint a partially verified single-case fallback", async () => {
    const ledger = new EvidenceLedger("run-partial-fallback");
    const items = [caseItem("first", "Core"), caseItem("second", "Callback")];
    await establishPlan(ledger, items);
    await ledger.execute("metersphere_ms_create_test_case", items[0], async () => ({
      content: [{ type: "text", text: JSON.stringify([{
        id: "case-1", num: 1, name: "first", node_id: "leaf-Core",
        node_path: "/AI Draft/Feature/Core", priority: "P1", verified: true,
      }]) }],
    }));
    expect(ledger.completionReceipt()).toBeUndefined();

    await ledger.execute("metersphere_ms_create_test_case", items[1], async () => ({
      content: [{ type: "text", text: JSON.stringify([{
        id: "case-2", num: 2, name: "second", node_id: "leaf-Callback",
        node_path: "/AI Draft/Feature/Callback", priority: "P1", verified: true,
      }]) }],
    }));
    expect(ledger.completionReceipt()).toMatchObject({
      casePlanHash: ledger.casePlan()?.planHash,
      caseOperation: { itemCount: 2, verifiedCount: 2 },
    });
  });

  it("restores the persisted CasePlan and reuses its exact payload on retry", async () => {
    const original = new EvidenceLedger("run-plan-source");
    const items = [caseItem("stable")];
    const plan = await establishPlan(original, items);
    const resumed = new EvidenceLedger("run-plan-resumed", { casePlan: plan });
    let effectiveInput: unknown;

    await resumed.execute("metersphere_ms_bulk_upsert_test_cases", {
      dry_run: false,
      items: JSON.stringify([{ ...items[0], name: "drifted", node_id: "wrong-module" }]),
    }, async input => {
      effectiveInput = input;
      return { content: [{ type: "text", text: JSON.stringify([{
        success: true, dry_run: false, item_count: 1, created_count: 1, updated_count: 0,
        results: [{ id: "case-1", num: 1, name: "stable", node_id: "leaf-Core", node_path: "/AI Draft/Feature/Core", priority: "P1", verified: true }],
      }]) }] };
    });

    expect(JSON.parse((effectiveInput as { items: string }).items)).toEqual(items);
    expect(resumed.completionReceipt()).toMatchObject({
      casePlanHash: plan.planHash,
      caseOperation: { verifiedCount: 1 },
    });
  });
});
