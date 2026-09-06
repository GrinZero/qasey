import { describe, expect, it } from "vitest";
import { freezeE2EContext, InMemoryCaseHubRepository } from "../../packages/domain/src/index.ts";

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
