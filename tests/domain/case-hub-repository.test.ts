import { describe, expect, it } from "vitest";
import { freezeE2EContext, InMemoryCaseHubRepository } from "../../packages/domain/src/index.ts";

const owner = { applicationId: "qasey", tenantId: "tenant-1" };
const repository = { owner: "example", repository: "web", cloneUrl: "https://example.com/web.git", baseRef: "main", allowedPaths: ["e2e"], skillsPaths: [] };

describe("Case Hub repository", () => {
  it("maps request_changes verdicts to the persisted changes_requested status", async () => {
    const hub = new InMemoryCaseHubRepository(() => new Date("2026-09-04T00:00:00.000Z"));
    const requirement = freezeE2EContext({
      goal: "Review a failed case", requirementSummary: "Request a repair", inScope: ["web"], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [], criticalFlows: ["repair"], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
    }, { sessionId: "s", threadId: "t", taskRunId: "task", requestId: "r", resourceId: "u" });
    const changeSet = await hub.createChangeSet(owner, {
      requirement, repository, createdBy: "qa-1", proposals: [{
        operation: "create", suitePath: "Navigation", title: "Scroll navigation", description: "", priority: "P1", preconditions: [],
        steps: [{ action: "Scroll", expected: ["Navigation reaches the end"] }], testData: {}, tags: [], automationPath: "tests/browser/navigation.e2e.spec.ts", evidenceRefs: [],
      }],
    });
    const [result] = await hub.createPendingResults(owner, changeSet.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", [], undefined, [{
      caseId: "QASEY-1", executionStatus: "failed", artifactNames: [],
    }]);

    const reviewed = await hub.reviewResult(owner, result!.id, "reviewer-1", {
      verdict: "request_changes",
      feedback: "补充稳定的滚动压力数据",
    });

    expect(reviewed.reviewStatus).toBe("changes_requested");
  });

  it("keeps proposals out of the formal library and preserves active metadata until merge activation", async () => {
    let now = new Date("2026-09-01T00:00:00.000Z");
    const hub = new InMemoryCaseHubRepository(() => now);
    const requirement = freezeE2EContext({
      goal: "Govern formal cases", requirementSummary: "Only merged cases are searchable", inScope: ["web"], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [], criticalFlows: ["search"], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
    }, { sessionId: "s", threadId: "t", taskRunId: "task", requestId: "r", resourceId: "u" });
    const created = await hub.createChangeSet(owner, {
      requirement, repository, createdBy: "qa-1", proposals: [{
        operation: "create", suitePath: "Appointments / Original", title: "Original active title", description: "", priority: "P1", preconditions: [],
        steps: [{ action: "Submit", expected: ["The case is verified"] }], testData: {}, tags: [], automationPath: "e2e/formal-case.spec.ts", evidenceRefs: [],
      }],
    });
    const [firstVersion] = await hub.versionsForChangeSet(owner, created.id);
    expect(await hub.listCases(owner)).toEqual([]);
    expect((await hub.getCase(owner, firstVersion!.caseId))?.activeVersionId).toBeUndefined();

    const [result] = await hub.createPendingResults(owner, created.id, "11111111-1111-4111-8111-111111111111", [
      { id: "video", kind: "video", name: `verifier/${firstVersion!.caseId}/video.webm`, uri: "file:///tmp/formal.webm" },
    ]);
    await hub.reviewResult(owner, result!.id, "qa-1", { verdict: "approve" });
    expect(await hub.listCases(owner)).toEqual([]);

    now = new Date("2026-09-01T01:00:00.000Z");
    await hub.activateApprovedVersions(owner, created.id);
    expect(await hub.listCases(owner)).toEqual([
      expect.objectContaining({ id: firstVersion!.caseId, activeVersionId: firstVersion!.id, title: "Original active title", suitePath: "Appointments / Original" }),
    ]);

    const update = await hub.createChangeSet(owner, {
      requirement, repository, createdBy: "qa-1", proposals: [{
        operation: "update", caseId: firstVersion!.caseId, suitePath: "Appointments / Candidate", title: "Unmerged candidate title", description: "", priority: "P2", preconditions: [],
        steps: [{ action: "Edit", expected: ["The candidate remains isolated"] }], testData: {}, tags: [], automationPath: "e2e/formal-case.spec.ts", evidenceRefs: [],
      }],
    });
    const [candidate] = await hub.versionsForChangeSet(owner, update.id);
    expect(await hub.listCases(owner)).toEqual([
      expect.objectContaining({ activeVersionId: firstVersion!.id, title: "Original active title", suitePath: "Appointments / Original" }),
    ]);

    const [candidateResult] = await hub.createPendingResults(owner, update.id, "22222222-2222-4222-8222-222222222222", [
      { id: "candidate-video", kind: "video", name: `verifier/${candidate!.caseId}/video.webm`, uri: "file:///tmp/candidate.webm" },
    ]);
    await hub.reviewResult(owner, candidateResult!.id, "qa-1", { verdict: "approve" });
    await hub.activateApprovedVersions(owner, update.id);
    expect(await hub.listCases(owner)).toEqual([
      expect.objectContaining({ activeVersionId: candidate!.id, title: "Unmerged candidate title", suitePath: "Appointments / Candidate" }),
    ]);
  });

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
      { id: "implementation-log", kind: "log", name: "verifier/repo-install.log", uri: "file:///tmp/repo-install.log" },
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
    await expect(hub.reviewResult(owner, second!.id, "qa-1", { verdict: "approve" }))
      .rejects.toThrow("A video or Playwright trace is required before approval");
    expect(first?.reviewStatus).toBe("pending");
    expect((await hub.versionsForCase(owner, version!.caseId))[0]?.status).toBe("proposed");
  });

  it("does not consume candidate Case numbers until every Case is approved", async () => {
    const hub = new InMemoryCaseHubRepository(() => new Date("2026-09-01T00:00:00.000Z"));
    const requirement = freezeE2EContext({
      goal: "Keep Case ids dense", requirementSummary: "Rejected attempts do not consume ids", inScope: ["web"], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [], criticalFlows: ["approve"], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
    }, { sessionId: "s", threadId: "t", taskRunId: "task", requestId: "r", resourceId: "u" });
    const proposal = (title: string) => ({
      operation: "create" as const, suitePath: "Case Hub", title, description: "", priority: "P1" as const, preconditions: [],
      steps: [{ action: "Run", expected: ["Evidence exists"] }], testData: {}, tags: [], automationPath: "e2e/dense-id.spec.ts", evidenceRefs: [],
    });

    const rejectedAttempt = await hub.createChangeSet(owner, {
      requirement, repository, createdBy: "qa-1", proposals: [proposal("Rejected attempt")],
    });
    const [rejectedVersion] = await hub.versionsForChangeSet(owner, rejectedAttempt.id);
    expect(rejectedVersion?.caseId).toBe("QASEY-1");

    const acceptedAttempt = await hub.createChangeSet(owner, {
      requirement, repository, createdBy: "qa-1", proposals: [proposal("Accepted case"), proposal("Second accepted case")],
    });
    const acceptedVersions = await hub.versionsForChangeSet(owner, acceptedAttempt.id);
    expect(acceptedVersions.map(version => version.caseId).sort()).toEqual(["QASEY-1", "QASEY-2"]);
    expect(acceptedAttempt).toMatchObject({
      candidateCaseSequenceRange: { start: 1, end: 2 },
      caseIdsFinalized: false,
    });

    await expect(hub.finalizeApprovedCaseIds(owner, acceptedAttempt.id)).rejects.toThrow(/not approved/u);
    const results = await hub.createPendingResults(owner, acceptedAttempt.id, "33333333-3333-4333-8333-333333333333", [
      { id: "video-1", kind: "video", name: "QASEY-1/video.webm", uri: "file:///tmp/1.webm" },
      { id: "video-2", kind: "video", name: "QASEY-2/video.webm", uri: "file:///tmp/2.webm" },
    ]);
    for (const result of results) await hub.reviewResult(owner, result.id, "qa-1", { verdict: "approve" });
    const finalized = await hub.finalizeApprovedCaseIds(owner, acceptedAttempt.id);
    expect(finalized.caseIdsFinalized).toBe(true);
    expect((await hub.finalizeApprovedCaseIds(owner, acceptedAttempt.id)).revision).toBe(finalized.revision);

    const next = await hub.createChangeSet(owner, {
      requirement, repository, createdBy: "qa-1", proposals: [proposal("Next case")],
    });
    expect((await hub.versionsForChangeSet(owner, next.id))[0]?.caseId).toBe("QASEY-3");
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
