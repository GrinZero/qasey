import { describe, expect, it } from "vitest";
import type { CaseExecutionObservation } from "../../packages/domain/src/index.ts";
import { collectPlaywrightTest } from "../../src/mastra/workflows/e2e-workflow.ts";

describe("Playwright Case observations", () => {
  it("marks dependency-skipped tests with no result attempts as blocked", () => {
    const observed = new Map<string, CaseExecutionObservation>();
    collectPlaywrightTest({
      title: "QASEY-1 sidebar remains usable",
      annotations: [{ type: "qasey.case", description: "QASEY-1" }],
      results: [],
    }, "sidebar remains usable", observed);

    expect(observed.get("QASEY-1")).toEqual({
      caseId: "QASEY-1",
      executionStatus: "blocked",
      durationMs: 0,
      artifactNames: [],
    });
  });

  it("keeps video attachment paths for a passing Case", () => {
    const observed = new Map<string, CaseExecutionObservation>();
    collectPlaywrightTest({
      title: "QASEY-2 mobile sidebar",
      annotations: [{ type: "qasey.case", description: "QASEY-2" }],
      results: [{
        status: "passed",
        duration: 42,
        attachments: [{ path: "/tmp/test-results/qasey-2-mobile/video.webm" }],
      }],
    }, "mobile sidebar", observed);

    expect(observed.get("QASEY-2")).toMatchObject({
      executionStatus: "passed",
      artifactNames: ["qasey-2-mobile/video.webm"],
    });
  });
});
