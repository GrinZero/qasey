import type { CheckResult, E2ERun } from "../../contracts/src/index.ts";
import type { PublishedChange } from "./coordinator.ts";

const compact = (value: string, limit: number) => {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const prose = (value: string, limit = 500) => compact(value, limit)
  .replace(/[\\`*_{}\[\]<>#|]/gu, "\\$&");

/** Use frozen scope and verifier facts; never turn author prose into a pass claim. */
export function buildPullRequestDescription(
  run: Pick<E2ERun, "id" | "changeSetId" | "contextSnapshot" | "caseSnapshot" | "executionBrief">,
  changes: Pick<PublishedChange, "path" | "deleted">[],
  reviewUrl: string,
  checks: Pick<CheckResult, "id" | "passed" | "exitCode">[],
): { title: string; body: string } {
  const context = run.executionBrief?.context ?? run.contextSnapshot;
  const cases = run.executionBrief?.cases ?? run.caseSnapshot;
  const subject = context.goal.trim() || cases[0]?.title || "E2E coverage";
  const lines = [prose(context.requirementSummary.trim() || subject, 1_500)];
  if (cases.length) {
    lines.push("", "## Coverage", "");
    for (const testCase of cases.slice(0, 20)) {
      const expected = [...new Set(testCase.steps.flatMap(step => step.expected))];
      lines.push(`- ${prose(testCase.title)}${expected.length ? ` — ${prose(expected.join("; "), 700)}` : ""}`);
    }
    if (cases.length > 20) lines.push(`- ${cases.length - 20} more cases are available in the run review.`);
  }
  if (changes.length) {
    lines.push("", "## Files", "");
    for (const change of changes.slice(0, 30)) {
      lines.push(`- ${prose(change.path)}${change.deleted ? " (deleted)" : ""}`);
    }
    if (changes.length > 30) lines.push(`- ${changes.length - 30} more files; see the PR diff.`);
  }
  lines.push("", "## Verification", "");
  if (checks.length) {
    for (const check of checks) {
      lines.push(`- ${prose(check.id)}: ${check.passed && check.exitCode === 0 ? "passed" : "failed"} (exit ${check.exitCode}).`);
    }
  } else {
    lines.push("No check results were supplied with this publication.");
  }
  lines.push("", "QA review of individual cases is still pending.");
  if (context.outOfScope.length) {
    lines.push("", `Outside this run’s scope: ${prose(context.outOfScope.join("; "), 1_000)}.`);
  }
  const url = new URL(reviewUrl);
  if (url.protocol === "https:" || url.protocol === "http:") {
    const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost")
      || url.hostname.startsWith("127.") || url.hostname === "[::1]" || url.hostname === "0.0.0.0";
    lines.push("", `[Review cases and execution evidence](<${url.href.replace(/>/gu, "%3E")}>)${local ? " (local to the machine running Qasey)" : ""}.`);
  }
  lines.push("", "<details>", "<summary>Qasey run details</summary>", "",
    `Run: ${prose(run.id)}`, `Change set: ${prose(run.changeSetId)}`, "", "</details>");
  return { title: `test(e2e): ${compact(subject, 100)}`, body: lines.join("\n") };
}
