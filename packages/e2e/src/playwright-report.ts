export type PlaywrightFailureKind = "authentication_setup" | "target_tests" | "unclassified";

/** Classify final outcomes by the frozen project contract, never by error prose. */
export function classifyPlaywrightFailure(
  reports: readonly unknown[],
  setupProject: string,
  targetProjects: readonly string[],
): PlaywrightFailureKind {
  let setupFailed = false;
  let targetFailed = false;
  let unclassified = reports.length === 0;
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const visit = (value: unknown): void => {
    const suite = object(value);
    if (!suite) { unclassified = true; return; }
    if (suite.specs !== undefined && !Array.isArray(suite.specs)) unclassified = true;
    for (const value of Array.isArray(suite.specs) ? suite.specs : []) {
      const spec = object(value);
      if (!spec || !Array.isArray(spec.tests)) { unclassified = true; continue; }
      for (const value of spec.tests) {
        const test = object(value);
        if (!test) { unclassified = true; continue; }
        // Playwright's final status accounts for successful retries and expected failures.
        if (["expected", "flaky", "skipped"].includes(String(test.status))) continue;
        if (test.status !== "unexpected") { unclassified = true; continue; }
        if (test.projectName === setupProject) setupFailed = true;
        else if (typeof test.projectName === "string" && targetProjects.includes(test.projectName)) targetFailed = true;
        else unclassified = true;
      }
    }
    if (suite.suites !== undefined && !Array.isArray(suite.suites)) unclassified = true;
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child);
  };
  for (const value of reports) {
    const report = object(value);
    if (!report || !Array.isArray(report.suites)) { unclassified = true; continue; }
    if (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length > 0)) unclassified = true;
    visit(report);
  }
  if (setupFailed) return "authentication_setup";
  return targetFailed && !unclassified ? "target_tests" : "unclassified";
}
