import { describe, expect, it } from "vitest";
import { freezeE2EContext, InMemoryCaseHubRepository } from "../../packages/domain/src/index.ts";

const owner = { applicationId: "qasey", tenantId: "tenant-1" };
const repository = { owner: "example", repository: "web", cloneUrl: "https://example.com/web.git", baseRef: "main", allowedPaths: ["e2e"], skillsPaths: [] };

describe("Case Hub repository", () => {
  it("allocates stable ids, immutable versions, attempts, and per-case reviews", async () => {
    const hub = new InMemoryCaseHubRepository(() => new Date("2026-09-01T00:00:00.000Z"));
    const requirement = freezeE2EContext({
      goal: "Dogfood Case Hub", requirementSummary: "Create a first case", inScope: ["web"], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [], criticalFlows: ["create"], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
    }, { sessionId: "s", threadId: "t", taskRunId: "task", requestId: "r", resourceId: "u" });
    const changeSet = await hub.createChangeSet(owner, {
      requirement, repository, createdBy: "qa-1", proposals: [{
        operation: "create", suitePath: "Case Hub", title: "Create a case", description: "", priority: "P1", preconditions: [],
        steps: [{ action: "Submit", expected: ["Case is proposed"] }], testData: {}, tags: ["dogfood"], automationPath: "e2e/case-hub.spec.ts", evidenceRefs: [],
      }],
    });
    const [version] = await hub.versionsForChangeSet(owner, changeSet.id);
    expect(version).toMatchObject({ caseId: "QASEY-1", version: 1, status: "proposed" });
    const [first] = await hub.createPendingResults(owner, changeSet.id, "97bb25db-18df-428e-af86-be305ad8b2ff", [
      { id: "matching-video", kind: "video", name: "verifier/qasey-dogfood/truncated-output/video.webm", uri: "file:///tmp/video.webm" },
      { id: "other-video", kind: "video", name: "verifier/qasey-dogfood/another-case/video.webm", uri: "file:///tmp/other.webm" },
    ], undefined, [{
      caseId: version!.caseId,
      executionStatus: "passed",
      artifactNames: ["truncated-output/video.webm"],
    }]);
    expect(first?.artifacts.map(artifact => artifact.id)).toEqual(["matching-video"]);
    await hub.reviewResult(owner, first!.id, "qa-1", { verdict: "approve" });
    expect((await hub.versionsForCase(owner, version!.caseId))[0]?.status).toBe("approved");
    const [second] = await hub.createPendingResults(owner, changeSet.id, "d825e3e4-9dc3-4ad6-829c-2f31ead90bbb", [], [version!.id]);
    expect(second?.attempt).toBe(2);
    expect(first?.reviewStatus).toBe("pending");
    expect((await hub.versionsForCase(owner, version!.caseId))[0]?.status).toBe("proposed");
  });

  it("preserves unresolved blocking questions for the API lifecycle gate", async () => {
    const { CreateCaseHubChangeSetSchema } = await import("../../packages/contracts/src/index.ts");
    expect(CreateCaseHubChangeSetSchema.parse({ requirement: {
      goal: "g", requirementSummary: "r", blockingQuestions: ["Which role?"],
    }, proposals: [{ operation: "create", suitePath: "s", title: "t", priority: "P2", steps: [{ action: "a", expected: ["e"] }], automationPath: "e2e/a.spec.ts" }] }).requirement.blockingQuestions).toEqual(["Which role?"]);
    expect(CreateCaseHubChangeSetSchema.safeParse({
      requirement: { goal: "g", requirementSummary: "r" },
      proposals: [{ operation: "create", suitePath: "s", title: "t", priority: "P2", steps: [{ action: "a", expected: ["e"] }], automationPath: "e2e/a.spec.ts" }],
      environmentSourceSha: "a".repeat(40),
    }).success).toBe(false);
  });
});
