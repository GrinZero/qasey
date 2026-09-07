import { describe, expect, it } from "vitest";
import { classifyPlaywrightFailure } from "../../packages/e2e/src/playwright-report.ts";

const report = (...tests: unknown[]) => ({ suites: [{ suites: [{ specs: [{ tests }] }] }] });
const failed = (projectName: string) => ({ status: "unexpected", projectName });
const classify = (...reports: unknown[]) => classifyPlaywrightFailure(reports, "auth-init", ["chromium"]);

describe("structured Playwright failure classification", () => {
  it("recognizes the declared setup project regardless of assertion prose or target failures", () => {
    expect(classify(report(failed("auth-init"), failed("chromium")))).toBe("authentication_setup");
    expect(classify(report({ ...failed("chromium"), results: [{ errors: [{ message: "Authentication setup failed: 401" }] }] }))).toBe("target_tests");
  });

  it.each(["expected", "flaky", "skipped"])("ignores %s setup outcomes including failed retry attempts", status => {
    expect(classify(report({ projectName: "auth-init", status, results: [{ status: "failed" }, { status: "passed" }] }, failed("chromium")))).toBe("target_tests");
  });

  it("prioritizes a failed setup in any report over a target failure in another", () => {
    expect(classify(report(failed("chromium")), report(failed("auth-init")))).toBe("authentication_setup");
  });

  it.each([undefined, null, {}, { suites: [null] }, { suites: "invalid" }, report({ projectName: "chromium" }), report(failed("other")), report({ projectName: "chromium", status: "skipped" })])("does not authorize test repair from inconclusive evidence %j", value => {
    expect(classify(value)).toBe("unclassified");
  });

  it("does not authorize repair when a report is missing or has global infrastructure errors", () => {
    expect(classify()).toBe("unclassified");
    expect(classify(report(failed("chromium")), undefined)).toBe("unclassified");
    expect(classify({ ...report(failed("chromium")), errors: [{ message: "Browser disconnected" }] })).toBe("unclassified");
  });
});
