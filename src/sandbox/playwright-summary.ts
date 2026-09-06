/** Keep assertion errors ahead of attachment listings in bounded repair feedback. */
export function summarizePlaywright(report: unknown, stdout: string, stderr: string): string {
  const failures: string[] = [];
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {};
  const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const errorText = (value: unknown): string => {
    const error = object(value);
    return typeof error.message === "string" ? error.message : typeof error.value === "string" ? error.value : "";
  };
  const root = object(report);
  for (const error of array(root.errors)) {
    const message = errorText(error);
    if (message) failures.push(message);
  }
  const visit = (value: unknown): void => {
    const suite = object(value);
    for (const value of array(suite.specs)) {
      const spec = object(value);
      for (const value of array(spec.tests)) {
        const test = object(value);
        // A successful retry is not a final test failure.
        if (test.status === "expected" || test.status === "flaky" || test.status === "skipped") continue;
        for (const value of array(test.results)) {
          const result = object(value);
          const errors = array(result.errors);
          if (errors.length === 0 && result.error) errors.push(result.error);
          for (const error of errors) {
            const message = errorText(error);
            if (message) failures.push(`${String(spec.title ?? "Playwright test")} (${String(spec.file ?? "")}:${String(spec.line ?? "")}) [${String(test.projectName ?? "")}]:\n${message}`);
          }
        }
      }
    }
    for (const child of array(suite.suites)) visit(child);
  };
  visit(root);
  const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/gu, "");
  if (failures.length) return stripAnsi([...new Set(failures)].join("\n\n")).slice(0, 4_000);
  const output = stripAnsi([stderr, stdout].filter(Boolean).join("\n")).trim();
  if (!output) return "Playwright completed";
  return output.length <= 4_000 ? output : `${output.slice(0, 2_500)}\n…\n${output.slice(-1_400)}`;
}
