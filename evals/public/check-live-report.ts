import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateLiveEvalReport } from "./validator.ts";

const reportArgument = process.argv[2];
if (!reportArgument) {
  process.stderr.write("Usage: pnpm evals:gate:live -- <provider-live-report.json>\n");
  process.stderr.write("This command validates real provider evidence; it does not run or simulate the Agent.\n");
  process.exitCode = 2;
} else {
  const datasetPath = resolve(import.meta.dirname, "cases.v1.json");
  const reportPath = resolve(process.cwd(), reportArgument);
  const [dataset, report] = await Promise.all([datasetPath, reportPath].map(async path =>
    JSON.parse(await readFile(path, "utf8")) as unknown,
  ));
  const result = evaluateLiveEvalReport(dataset, report);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
