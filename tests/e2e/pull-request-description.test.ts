import { describe, expect, it } from "vitest";
import { E2EContextSnapshotSchema, TestCaseSpecSchema } from "../../packages/contracts/src/index.ts";
import { buildPullRequestDescription } from "../../packages/e2e/src/pull-request-description.ts";

const contextSnapshot = E2EContextSnapshotSchema.parse({
  version: 1, goal: "Cover sidebar collapse and navigation",
  requirementSummary: "The sidebar should preserve navigation when collapsed.",
  source: { sessionId: "session", threadId: "thread", taskRunId: "task", requestId: "request", resourceId: "resource" },
  createdAt: "2026-09-07T00:00:00.000Z", snapshotHash: "a".repeat(64),
});
const testCase = TestCaseSpecSchema.parse({
  id: "case-1", title: "Navigate with a collapsed sidebar", target: "web", priority: "P1",
  steps: [{ action: "Collapse and select a destination", expected: ["The selected page opens"] }],
  preconditions: [], evidenceRefs: [], testData: {}, tags: [], unresolvedQuestions: [],
});
const run = { id: "run-1", changeSetId: "change-1", contextSnapshot, caseSnapshot: [testCase] };

describe("PR descriptions", () => {
  it("leads with the task and supplies concrete coverage, changed files, and verifier results", () => {
    const result = buildPullRequestDescription(run,
      [{ path: "tests/sidebar.spec.ts", deleted: false }], "https://qasey.example/runs/run-1",
      [{ id: "playwright", passed: true, exitCode: 0 }]);
    expect(result.title).toBe("test(e2e): Cover sidebar collapse and navigation");
    expect(result.body.startsWith(contextSnapshot.requirementSummary)).toBe(true);
    expect(result.body).toContain("Navigate with a collapsed sidebar — The selected page opens");
    expect(result.body).toContain("tests/sidebar.spec.ts");
    expect(result.body).toContain("playwright: passed (exit 0)");
    expect(result.body).toContain("QA review of individual cases is still pending");
    expect(result.body.indexOf("Run: run-1")).toBeGreaterThan(result.body.indexOf("## Verification"));
  });

  it("does not imply success for missing or failed checks and labels local evidence", () => {
    const missing = buildPullRequestDescription(run, [], "http://localhost:4111/runs/run-1", []);
    expect(missing.body).toContain("No check results");
    expect(missing.body).toContain("local to the machine running Qasey");
    const failed = buildPullRequestDescription(run, [], "https://qasey.example/runs/run-1",
      [{ id: "playwright", passed: false, exitCode: 1 }]);
    expect(failed.body).toContain("playwright: failed (exit 1)");
    expect(failed.body).not.toContain("playwright: passed");
  });

  it("bounds long titles and renders supplied markup as text", () => {
    const result = buildPullRequestDescription({ ...run, contextSnapshot: {
      ...contextSnapshot, goal: "Long goal\n".repeat(30), requirementSummary: "<details> supplied *text*",
    } }, [{ path: "tests/old.spec.ts", deleted: true }], "https://qasey.example/runs/run-1", []);
    expect(result.title.length).toBeLessThanOrEqual(111);
    expect(result.title).not.toContain("\n");
    expect(result.body).toContain("\\<details\\> supplied \\*text\\*");
    expect(result.body).toContain("tests/old.spec.ts (deleted)");
  });
});
