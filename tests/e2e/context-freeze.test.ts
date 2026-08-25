import { describe, expect, it } from "vitest";
import { canonicalMeterSphereCaseIdFromList, freezeE2EContext, freezeE2EExecutionBrief, isCanonicalMeterSphereCaseId, testCaseSpecFromMeterSphere } from "../../packages/domain/src/index.ts";

describe("immutable E2E context", () => {
  it("resolves numeric MeterSphere case numbers to canonical UUID ids", () => {
    const canonicalId = "97bb25db-18df-428e-af86-be305ad8b2ff";
    const response = {
      content: [{
        type: "text",
        text: JSON.stringify([{ cases: [
          { id: canonicalId, num: 175088, name: "Exact case" },
          { id: "d825e3e4-9dc3-4ad6-829c-2f31ead90bbb", num: 1750880, name: "Fuzzy result" },
        ] }]),
      }],
    };

    expect(canonicalMeterSphereCaseIdFromList("175088", response)).toBe(canonicalId);
    expect(isCanonicalMeterSphereCaseId(canonicalId)).toBe(true);
    expect(() => canonicalMeterSphereCaseIdFromList("175089", response)).toThrow(
      "did not resolve to a canonical UUID id",
    );
  });

  it("redacts secrets and keeps conversation evidence alongside complete MeterSphere steps", () => {
    const snapshot = freezeE2EContext({
      goal: "Cover checkout",
      requirementSummary: "Use Authorization: Bearer secret-value-that-must-not-leak",
      inScope: ["checkout"], outOfScope: [], confirmedDecisions: ["web only"], constraints: [], assumptions: [],
      criticalFlows: ["submit order"], boundaryCases: [], negativeCases: [], testDataNeeds: ["testing account"], repositoryFindings: ["reuse checkout fixture"],
      blockingQuestions: [], evidenceRefs: [{ kind: "message", ref: "thread:42", summary: "confirmed behavior" }],
    }, { sessionId: "session", threadId: "thread", taskRunId: "task", requestId: "request", resourceId: "resource" }, new Date("2026-08-25T00:00:00.000Z"));
    const testCase = testCaseSpecFromMeterSphere("MS-1", {
      id: "MS-1", name: "Checkout succeeds", platform: "web", priority: "P1",
      preconditions: ["signed in"], steps: [{ action: "Submit order", expected_result: "Success page is shown" }], test_data: { tenant: "testing", password: "do-not-persist" },
    });
    const brief = freezeE2EExecutionBrief({
      context: snapshot, cases: [testCase],
      repository: { owner: "MoeGolibrary", repository: "moego-e2e-autotest", workspacePath: "repos/MoeGolibrary/moego-e2e-autotest", baseSha: "a".repeat(40), allowedPaths: ["tests"], skillPaths: [".agents/skills"], specGlobs: ["tests"], artifactGlobs: ["artifacts/**"] },
      now: new Date("2026-08-25T00:01:00.000Z"),
    });

    expect(snapshot.requirementSummary).not.toContain("secret-value-that-must-not-leak");
    expect(snapshot.requirementSummary).toContain("[REDACTED]");
    expect(brief.context.evidenceRefs).toContainEqual(expect.objectContaining({ ref: "thread:42" }));
    expect(brief.cases[0]!.steps[0]).toEqual({ action: "1. Submit order", expected: ["Success page is shown"] });
    expect(brief.cases[0]!.testData.password).toBe("[REDACTED]");
    expect(brief.briefHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
