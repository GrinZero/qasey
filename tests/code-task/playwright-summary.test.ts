import { describe, expect, it } from "vitest";
import { summarizePlaywright } from "../../src/sandbox/playwright-summary.ts";

describe("Playwright repair feedback", () => {
  it("retains the assertion and location when attachments consume the console tail", () => {
    const report = { suites: [{ suites: [{ specs: [{ title: "sidebar scrolls", file: "sidebar.e2e.spec.ts", line: 23, tests: [{
      status: "unexpected", projectName: "chromium", results: [{ errors: [{ message: "Expected: > 414\nReceived: 414" }] }],
    }] }] }] }] };
    const summary = summarizePlaywright(report, "attachment trace.zip\n".repeat(1000), "");
    expect(summary).toContain("Expected: > 414\nReceived: 414");
    expect(summary).toContain("sidebar.e2e.spec.ts:23");
    expect(summary).not.toContain("trace.zip");
  });

  it("reports setup errors and tolerates absent or malformed report structures", () => {
    expect(summarizePlaywright({ errors: [{ message: "Authentication precondition failed" }] }, "", "")).toBe("Authentication precondition failed");
    expect(summarizePlaywright(undefined, "x".repeat(8000), "Browser launch failed")).toMatch(/^Browser launch failed/u);
    expect(summarizePlaywright({ suites: [null] }, "", "")).toBe("Playwright completed");
  });
});
