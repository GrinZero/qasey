import { describe, expect, it } from "vitest";
import { freezeE2EContext, InMemoryCaseHubRepository, projectCaseHubDetail } from "../../packages/domain/src/index.ts";

const owner = { applicationId: "qasey", tenantId: "tenant-1" };
const repository = { owner: "example", repository: "web", cloneUrl: "https://example.com/web.git", baseRef: "main", allowedPaths: ["e2e"], skillsPaths: [] };
const requirement = freezeE2EContext({
  goal: "Review before automation", requirementSummary: "Publish text first", inScope: ["web"], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [], criticalFlows: ["review"], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
}, { sessionId: "11111111-1111-4111-8111-111111111111", threadId: "thread-1", taskRunId: "task-1", requestId: "request-1", resourceId: "qa-1" });
const proposal = (title: string) => ({
  operation: "create" as const, suitePath: "Appointments / Review", title, description: "", priority: "P1" as const,
  preconditions: [], steps: [{ action: "Submit", expected: ["The result is visible"] }], testData: {}, tags: ["review"],
});

describe("text Case Review gate", () => {
  it("ends a review without deleting approved cases, and enforces ownership and revisions", async () => {
    const hub = new InMemoryCaseHubRepository();
    let detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("Keep approved case")], createdBy: "qa-1",
    });
    detail = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: detail.items[0]!.id, expectedRevision: 1 }]);
    await expect(hub.cancelReviewPlan(owner, detail.plan.id, "someone-else", detail.plan.revision)).rejects.toThrow();
    await expect(hub.cancelReviewPlan({ ...owner, tenantId: "other" }, detail.plan.id, "qa-1", detail.plan.revision)).rejects.toThrow();
    await expect(hub.cancelReviewPlan(owner, detail.plan.id, "qa-1", 1)).rejects.toThrow(/revision conflict/);
    const cancelled = await hub.cancelReviewPlan(owner, detail.plan.id, "qa-1", detail.plan.revision);
    expect(cancelled.plan.status).toBe("cancelled");
    expect(cancelled.editable).toBe(false);
    expect(cancelled.items).toEqual(detail.items);
    expect(await hub.listCases(owner)).toHaveLength(1);
    expect(await hub.cancelReviewPlan(owner, detail.plan.id, "qa-1", detail.plan.revision)).toEqual(cancelled);
    await expect(hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: detail.items[0]!.id, expectedRevision: detail.items[0]!.revision }])).rejects.toThrow(/Cancelled/);
  });

  it("keeps an active repair or final verification generating despite an earlier result", async () => {
    const hub = new InMemoryCaseHubRepository();
    let detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("Repair lifecycle")], createdBy: "qa-1",
    });
    detail = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: detail.items[0]!.id, expectedRevision: detail.items[0]!.revision }]);
    const versionId = detail.items[0]!.publishedCaseVersionId!;
    const created = await hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [versionId], repository, createdBy: "qa-1" });
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("generating");

    const verifying = await hub.updateChangeSet(owner, created.id, created.revision, { status: "verifying" });
    const [failedResult] = await hub.createPendingResults(owner, created.id, "33333333-3333-4333-8333-333333333333", [], undefined, [{ caseId: "QASEY-1", executionStatus: "failed" }]);
    await hub.reviewResult(owner, failedResult!.id, "qa-1", { verdict: "request_changes", feedback: "Repair needed." });
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("generating");

    const awaitingReview = await hub.updateChangeSet(owner, verifying.id, verifying.revision, { status: "awaiting_review" });
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("failed");
    const revising = await hub.updateChangeSet(owner, awaitingReview.id, awaitingReview.revision, { status: "revising" });
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("generating");
    const repairing = await hub.updateChangeSet(owner, revising.id, revising.revision, { status: "verifying" });
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("generating");

    const secondReview = await hub.updateChangeSet(owner, repairing.id, repairing.revision, { status: "awaiting_review" });
    const [approvedResult] = await hub.createPendingResults(owner, created.id, "44444444-4444-4444-8444-444444444444", [
      { id: "repaired-video", kind: "video", name: "QASEY-1/video.webm", uri: "file:///tmp/repaired.webm" },
    ]);
    await hub.reviewResult(owner, approvedResult!.id, "qa-1", { verdict: "approve" });
    const finalVerifying = await hub.updateChangeSet(owner, secondReview.id, secondReview.revision, { status: "final_verifying" });
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("generating");
    expect(finalVerifying.status).toBe("final_verifying");
  });

  it("uses the newest Change Set creation, not a late update to an older run, for automation status", async () => {
    let now = new Date("2026-09-04T00:00:00.000Z");
    const hub = new InMemoryCaseHubRepository(() => now);
    let detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("Concurrent E2E")], createdBy: "qa-1",
    });
    detail = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: detail.items[0]!.id, expectedRevision: detail.items[0]!.revision }]);
    const versionId = detail.items[0]!.publishedCaseVersionId!;

    const older = await hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [versionId], repository, createdBy: "qa-1" });
    const olderVerifying = await hub.updateChangeSet(owner, older.id, older.revision, { status: "verifying" });
    const olderAwaitingReview = await hub.updateChangeSet(owner, olderVerifying.id, olderVerifying.revision, { status: "awaiting_review" });
    now = new Date("2026-09-04T00:01:00.000Z");
    const [olderResult] = await hub.createPendingResults(owner, older.id, "11111111-1111-4111-8111-111111111111", [
      { id: "older-video", kind: "video", name: "QASEY-1/video.webm", uri: "file:///tmp/older.webm" },
    ]);
    await hub.reviewResult(owner, olderResult!.id, "qa-1", { verdict: "approve" });

    now = new Date("2026-09-04T00:02:00.000Z");
    const newer = await hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [versionId], repository, createdBy: "qa-1" });
    const newerVerifying = await hub.updateChangeSet(owner, newer.id, newer.revision, { status: "verifying" });
    const newerAwaitingReview = await hub.updateChangeSet(owner, newerVerifying.id, newerVerifying.revision, { status: "awaiting_review" });
    now = new Date("2026-09-04T00:03:00.000Z");
    const [newerResult] = await hub.createPendingResults(owner, newer.id, "22222222-2222-4222-8222-222222222222", [], undefined, [{ caseId: "QASEY-1", executionStatus: "failed" }]);
    await hub.reviewResult(owner, newerResult!.id, "qa-1", { verdict: "request_changes", feedback: "The newest attempt failed." });

    // The older run completes a workflow phase after the newer run has
    // already failed. Its later updatedAt must not become the current state.
    now = new Date("2026-09-04T00:04:00.000Z");
    await hub.updateChangeSet(owner, olderAwaitingReview.id, olderAwaitingReview.revision, { status: "final_verifying" });
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("failed");
    expect(newerAwaitingReview.status).toBe("awaiting_review");
  });

  it("keeps a failed historical version separate from the current verified version", async () => {
    let now = new Date("2026-09-04T00:00:00.000Z");
    const hub = new InMemoryCaseHubRepository(() => now);
    let detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("Original copy")], createdBy: "qa-1",
    });
    detail = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: detail.items[0]!.id, expectedRevision: detail.items[0]!.revision }]);
    const firstVersionId = detail.items[0]!.publishedCaseVersionId!;
    const failedChangeSet = await hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [firstVersionId], repository, createdBy: "qa-1" });
    now = new Date("2026-09-04T00:01:00.000Z");
    const [failedResult] = await hub.createPendingResults(owner, failedChangeSet.id, "11111111-1111-4111-8111-111111111111", [], undefined, [{ caseId: "QASEY-1", executionStatus: "failed" }]);
    await hub.reviewResult(owner, failedResult!.id, "qa-1", { verdict: "request_changes", feedback: "The old scenario failed." });
    await hub.updateChangeSet(owner, failedChangeSet.id, failedChangeSet.revision, { status: "failed" });

    now = new Date("2026-09-04T00:02:00.000Z");
    const revised = await hub.updateReviewItem(owner, detail.plan.id, detail.items[0]!.id, "qa-1", detail.items[0]!.revision, { ...detail.items[0]!.content, title: "Current copy" });
    detail = await hub.approveReviewItems(owner, revised.plan.id, "qa-1", [{ itemId: revised.items[0]!.id, expectedRevision: revised.items[0]!.revision }]);
    const currentVersionId = detail.items[0]!.publishedCaseVersionId!;
    const verifiedChangeSet = await hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [currentVersionId], repository, createdBy: "qa-1" });
    const verifying = await hub.updateChangeSet(owner, verifiedChangeSet.id, verifiedChangeSet.revision, { status: "verifying" });
    const awaitingReview = await hub.updateChangeSet(owner, verifying.id, verifying.revision, { status: "awaiting_review" });
    now = new Date("2026-09-04T00:03:00.000Z");
    const [verifiedResult] = await hub.createPendingResults(owner, awaitingReview.id, "22222222-2222-4222-8222-222222222222", [
      { id: "current-video", kind: "video", name: "QASEY-1/video.webm", uri: "file:///tmp/current-video.webm" },
    ]);
    await hub.reviewResult(owner, verifiedResult!.id, "qa-1", { verdict: "approve" });
    await expect(hub.automationStatuses(owner, [firstVersionId, currentVersionId])).resolves.toEqual({
      [firstVersionId]: "failed",
      [currentVersionId]: "verified",
    });

    const caseRecord = await hub.getCase(owner, "QASEY-1");
    const versions = await hub.versionsForCase(owner, "QASEY-1");
    const changeSets = await hub.listChangeSets(owner);
    const results = (await Promise.all(changeSets.map(changeSet => hub.listResults(owner, changeSet.id)))).flat();
    const projected = projectCaseHubDetail(caseRecord!, versions, changeSets, results);

    expect(projected.current.version).toMatchObject({ id: currentVersionId, version: 2, isCurrent: true, automationStatus: "verified" });
    expect(projected.case).toMatchObject({ activeVersionId: currentVersionId, automationStatus: "verified", systemTags: ["e2e"] });
    expect(projected.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        version: expect.objectContaining({ id: firstVersionId, version: 1, isCurrent: false, automationStatus: "failed" }),
        changeSets: [expect.objectContaining({ id: failedChangeSet.id, status: "failed" })],
        results: [expect.objectContaining({ id: failedResult!.id, executionStatus: "failed", reviewStatus: "changes_requested" })],
      }),
    ]));
  });

  it("deletes published cases idempotently within their owner and preserves history", async () => {
    const hub = new InMemoryCaseHubRepository();
    const detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("Delete me"), proposal("Keep me")], createdBy: "qa-1",
    });
    await hub.approveReviewItems(owner, detail.plan.id, "qa-1", detail.items.map(item => ({ itemId: item.id, expectedRevision: item.revision })));
    const versions = await hub.versionsForCase(owner, "QASEY-1");
    const changeSet = await hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [versions[0]!.id], repository, createdBy: "qa-1" });
    const results = await hub.createPendingResults(owner, changeSet.id, "77777777-7777-4777-8777-777777777777", [
      { id: "video", kind: "video", name: "QASEY-1/video.webm", uri: "file:///tmp/example-video.webm" },
    ]);
    expect(await hub.deleteCase({ ...owner, tenantId: "another-tenant" }, "QASEY-1")).toBe(false);
    expect(await hub.deleteCase({ ...owner, applicationId: "another-app" }, "QASEY-1")).toBe(false);
    expect(await hub.getCase(owner, "QASEY-1")).toBeDefined();
    expect(await hub.deleteCase(owner, "QASEY-1")).toBe(true);
    expect(await hub.deleteCase(owner, "QASEY-1")).toBe(true);
    expect(await hub.deleteCase(owner, "QASEY-999")).toBe(false);
    expect(await hub.getCase(owner, "QASEY-1")).toBeUndefined();
    expect((await hub.listCases(owner)).map(item => item.id)).toEqual(["QASEY-2"]);
    expect(await hub.listCases(owner, "Delete me")).toEqual([]);
    expect(await hub.versionsForCase(owner, "QASEY-1")).toEqual(versions);
    expect(await hub.listResults(owner, changeSet.id)).toEqual(results);
    await expect(hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [versions[0]!.id], repository, createdBy: "qa-1" })).rejects.toThrow("stale");
    await hub.reviewResult(owner, results[0]!.id, "qa-1", { verdict: "approve" });
    await hub.activateApprovedVersions(owner, changeSet.id);
    expect(await hub.getCase(owner, "QASEY-1")).toBeUndefined();
  });

  it("creates only a recoverable review plan and publishes approved text cases atomically", async () => {
    const hub = new InMemoryCaseHubRepository(() => new Date("2026-09-04T00:00:00.000Z"));
    const detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("First"), proposal("Second")], createdBy: "qa-1",
    });
    expect(detail.items.map(item => item.status)).toEqual(["pending", "pending"]);
    expect(await hub.listCases(owner)).toEqual([]);
    expect(await hub.listChangeSets(owner)).toEqual([]);

    await expect(hub.approveReviewItems(owner, detail.plan.id, "qa-1", [
      { itemId: detail.items[0]!.id, expectedRevision: detail.items[0]!.revision },
      { itemId: detail.items[1]!.id, expectedRevision: 99 },
    ])).rejects.toThrow("revision conflict");
    expect(await hub.listCases(owner)).toEqual([]);

    const approved = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", detail.items.map(item => ({ itemId: item.id, expectedRevision: item.revision })));
    expect(approved.plan.status).toBe("ready");
    expect(approved.items.map(item => item.publishedCaseId)).toEqual(["QASEY-1", "QASEY-2"]);
    expect((await hub.listCases(owner)).map(item => item.title)).toEqual(["First", "Second"]);
  });

  it("supports revision conflicts, soft removal, read-only viewers, and pending revisions over a live case", async () => {
    const hub = new InMemoryCaseHubRepository(() => new Date("2026-09-04T00:00:00.000Z"));
    let detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("Original")], createdBy: "qa-1",
    });
    const original = detail.items[0]!;
    expect((await hub.getReviewPlan(owner, detail.plan.id, "qa-2"))?.editable).toBe(false);
    await expect(hub.updateReviewItem(owner, detail.plan.id, original.id, "qa-2", original.revision, original.content)).rejects.toMatchObject({ code: "case_review_forbidden" });

    detail = await hub.setReviewItemRemoved(owner, detail.plan.id, original.id, "qa-1", original.revision, true);
    expect(detail.items[0]).toMatchObject({ status: "removed", removedFrom: "pending" });
    detail = await hub.setReviewItemRemoved(owner, detail.plan.id, original.id, "qa-1", detail.items[0]!.revision, false);
    detail = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: original.id, expectedRevision: detail.items[0]!.revision }]);
    const firstVersionId = detail.items[0]!.publishedCaseVersionId!;

    const editedContent = { ...detail.items[0]!.content, title: "Revised" };
    const edited = await hub.updateReviewItem(owner, detail.plan.id, original.id, "qa-1", detail.items[0]!.revision, editedContent);
    expect(edited.items[0]?.status).toBe("pending");
    expect((await hub.getCase(owner, "QASEY-1"))?.activeVersionId).toBe(firstVersionId);
    await expect(hub.updateReviewItem(owner, detail.plan.id, original.id, "qa-1", detail.items[0]!.revision, editedContent)).rejects.toMatchObject({ code: "case_review_revision_conflict" });
    const revised = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: original.id, expectedRevision: edited.items[0]!.revision }]);
    expect(revised.items[0]).toMatchObject({ publishedCaseId: "QASEY-1", status: "approved" });
    expect((await hub.versionsForCase(owner, "QASEY-1")).map(version => version.version)).toEqual([1, 2]);
    expect((await hub.getCase(owner, "QASEY-1"))?.activeVersionId).toBe(revised.items[0]!.publishedCaseVersionId);
  });

  it("creates one automation-only Change Set from exact active versions", async () => {
    const hub = new InMemoryCaseHubRepository(() => new Date("2026-09-04T00:00:00.000Z"));
    let detail = await hub.createReviewPlan(owner, {
      conversationId: requirement.source.sessionId, threadId: requirement.source.threadId, subjectId: "qa-1",
      requirement, proposals: [proposal("Automate")], createdBy: "qa-1",
    });
    detail = await hub.approveReviewItems(owner, detail.plan.id, "qa-1", [{ itemId: detail.items[0]!.id, expectedRevision: 1 }]);
    const versionId = detail.items[0]!.publishedCaseVersionId!;
    const changeSet = await hub.createAutomationChangeSet(owner, { requirement, caseVersionIds: [versionId], repository, createdBy: "qa-1" });
    expect(changeSet).toMatchObject({ caseVersionIds: [versionId], caseIdsFinalized: true, status: "authoring" });
    const [version] = await hub.versionsForChangeSet(owner, changeSet.id);
    expect(version).toMatchObject({ id: versionId, status: "active" });
    expect(version?.automationPath).toBeUndefined();
    expect((await hub.automationStatuses(owner, [versionId]))[versionId]).toBe("generating");
  });
});
