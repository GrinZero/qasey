import { describe, expect, it } from "vitest";
import { buildRunnerJob } from "../../packages/e2e/src/index.ts";
import { freezeE2EContext } from "../../packages/domain/src/index.ts";

describe("Kubernetes runner job", () => {
  it("does not mount a service account or grant container privileges", () => {
    const now = new Date().toISOString();
    const contextSnapshot = freezeE2EContext({
      goal: "test", requirementSummary: "test", inScope: [], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [],
      criticalFlows: [], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
    }, { sessionId: "s", threadId: "s", taskRunId: "r", requestId: "r", resourceId: "test" });
    const job = buildRunnerJob({
      applicationId: "qasey", tenantId: "tenant-1",
      id: "RUN_1", requestId: "r", sourceSessionId: "s", sourceCaseIds: ["c"], platform: "web", framework: "playwright",
      repository: { owner: "o", repository: "r", cloneUrl: "https://example.test/r.git", baseRef: "main", allowedPaths: ["tests"], skillsPaths: [] },
      contextSnapshot, caseSnapshot: [], amendments: [], codeTaskIds: [],
      status: "queued", createdAt: now, updatedAt: now, artifacts: [],
    }, "runner@sha256:abc");
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(job.spec.template.spec.containers[0]!.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true });
  });
});
