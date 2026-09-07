import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArtifactRef } from "../../packages/contracts/src/index.ts";
import { freezeE2EContext, InMemoryCaseHubRepository } from "../../packages/domain/src/index.ts";
import { latestVerifierArtifacts, LocalArtifactStore } from "../../packages/e2e/src/artifacts.ts";

const owner = { applicationId: "qasey", tenantId: "public-test" };
const runId = "11111111-1111-4111-8111-111111111111";

describe("result evidence after QA repair", () => {
  it("publishes only repaired verifier evidence while retaining the original attempt and run history", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-result-evidence-"));
    try {
      const store = new LocalArtifactStore(root);
      const artifacts: ArtifactRef[] = [];
      const codeTaskIds: string[] = [];
      const hub = new InMemoryCaseHubRepository();
      const requirement = freezeE2EContext({ goal: "Review sidebar", requirementSummary: "Repair evidence", inScope: ["web"], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [], criticalFlows: [], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [] }, { sessionId: "s", threadId: "t", taskRunId: "task", requestId: "r", resourceId: "u" });
      const changeSet = await hub.createChangeSet(owner, {
        requirement, createdBy: "public-qa", repository: { owner: "example", repository: "web", cloneUrl: "https://example.com/web.git", baseRef: "main", allowedPaths: ["e2e"], skillsPaths: [] },
        proposals: [{ operation: "create", suitePath: "Navigation", title: "Sidebar", description: "", priority: "P1", preconditions: [], steps: [{ action: "Collapse", expected: ["Icons remain"] }], testData: {}, tags: [], evidenceRefs: [] }],
      });
      const publish = async (attempt: number) => {
        const taskId = `${runId}:verifier:${attempt}`;
        codeTaskIds.push(taskId);
        for (const [kind, name] of [["trace", "QASEY-1/trace.zip"], ["video", "QASEY-1/video.webm"], ["report", "suite-results.json"], ["patch", "changes.patch"]] as const) {
          artifacts.push(await store.persistContent(owner, runId, "verifier", { id: `${taskId}:${kind}`, kind, name, uri: "sandbox://public/evidence" }, Buffer.from(`attempt-${attempt}`)));
        }
        return hub.createPendingResults(owner, changeSet.id, runId, latestVerifierArtifacts({ id: runId, codeTaskIds, artifacts }));
      };
      const [original] = await publish(0);
      await hub.reviewResult(owner, original!.id, "public-qa", { verdict: "request_changes", feedback: "Cover keyboard activation" });
      // A renamed/removed test path must not pull evidence from the prior run.
      artifacts.push(await store.persistContent(owner, runId, "verifier", { id: `${runId}:verifier:0:old-only`, kind: "video", name: "QASEY-1-old/video.webm", uri: "sandbox://public/old" }, Buffer.from("old")));
      const [repaired] = await publish(1);
      expect(repaired!.attempt).toBe(2);
      expect(repaired!.artifacts).toHaveLength(2);
      expect(repaired!.artifacts.every(artifact => artifact.id.includes("-verifier-1-"))).toBe(true);
      expect(repaired!.testCodeHash).not.toBe(original!.testCodeHash);
      const history = await hub.listResults(owner, changeSet.id);
      expect(history.find(result => result.id === original!.id)?.artifacts).toEqual(original!.artifacts);
      expect(artifacts).toHaveLength(9);
      expect(latestVerifierArtifacts({ id: runId, codeTaskIds, artifacts })).toHaveLength(4);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when the newest verifier has not produced evidence", () => {
    expect(() => latestVerifierArtifacts({ id: runId, codeTaskIds: [`${runId}:verifier:1`], artifacts: [{ id: `${runId}:verifier:${runId}-verifier-10-trace`, kind: "trace", name: "trace.zip", uri: "sandbox://public/old" }] })).toThrow("latest verifier");
    expect(() => latestVerifierArtifacts({ id: runId, codeTaskIds: [], artifacts: [] })).toThrow("verifier CodeTask");
  });
});
