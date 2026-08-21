import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("golden QA workflow dataset", () => {
  it("builds deterministic Mastra and Datadog exports", () => {
    execFileSync(process.execPath, ["evals/golden/scripts/build-exports.mjs"], { cwd: repoRoot });

    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/exports/manifest.json"), "utf8"));
    const mastraItems = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/exports/mastra-items.json"), "utf8"));
    const mastraSafeItems = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/exports/mastra-safe-items.json"), "utf8"));
    const datadogRecords = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/exports/datadog-records.json"), "utf8"));

    expect(manifest.recordCount).toBe(32);
    expect(mastraItems).toHaveLength(32);
    expect(mastraSafeItems).toHaveLength(32);
    expect(datadogRecords).toHaveLength(32);
    expect(new Set(mastraItems.map((item: { externalId: string }) => item.externalId)).size).toBe(32);
    expect(manifest.rawSourceRequired).toBe(false);
    for (const item of mastraItems) {
      expect(item.requestContext).toHaveProperty("qasey-context");
      expect(item.requestContext).not.toHaveProperty("intent-route");
    }
  });

  it("keeps reads live and mocks every classified side-effect tool", () => {
    const safeItems = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/exports/mastra-safe-items.json"), "utf8"));
    const effects = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/tool-effects.v1.json"), "utf8"));

    for (const item of safeItems) {
      expect(item.unmockedToolPolicy).toBe("allow");
      expect(item.metadata.experiment_mode).toBe("live_reads_mocked_writes");
      const mocked = new Set(item.toolMocks.map((mock: { toolName: string }) => mock.toolName));
      for (const toolName of effects.sideEffectTools) expect(mocked.has(toolName)).toBe(true);
      for (const toolName of effects.readOnlyTools) expect(mocked.has(toolName)).toBe(false);
    }
  });

  it("builds from the minimal provenance snapshot instead of raw chats", () => {
    const evidence = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/source-evidence.v1.json"), "utf8"));
    const canonical = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/qa-workflows.v1.json"), "utf8"));
    const byFile = new Map(evidence.sources.map((source: { file: string }) => [source.file, source]));

    expect(evidence.mode).toBe("minimal_sanitized_provenance");
    expect(evidence.sources).toHaveLength(19);
    for (const record of canonical.records) {
      const source = byFile.get(record.source.file) as { originalSha256: string; goldenIds: string[]; excerpts: string[] };
      expect(source.originalSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.goldenIds).toContain(record.id);
      expect(source.excerpts).toContain(record.source.excerpt);
    }
  });

  it("keeps uploadable exports sanitized and enforces write/read-back contracts", () => {
    const mastraItems = JSON.parse(readFileSync(path.join(repoRoot, "evals/golden/exports/mastra-items.json"), "utf8"));
    const serialized = JSON.stringify(mastraItems);

    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("@moego.pet");
    expect(serialized).not.toContain("moegoworkspace.slack.com/archives/");
    expect(serialized).not.toContain("moego.atlassian.net/browse/");

    for (const item of mastraItems) {
      expect(item.expectedTrajectory.forbiddenCapabilities).toContain("metersphere_delete");
      if (item.groundTruth.writePolicy === "metersphere_upsert") {
        expect(item.groundTruth.readbackRequired).toBe(true);
      }
    }
  });
});
