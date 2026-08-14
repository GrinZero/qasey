import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArtifactRef } from "../../contracts/src/index.ts";
import type { WorkspaceRef } from "./workspace.ts";
import { runSafeCommand } from "./process.ts";

export type E2EFramework = "playwright" | "maestro";
export interface E2ERunResult { passed: boolean; exitCode: number; summary: string; artifacts: ArtifactRef[]; }
export interface E2ERunner { readonly framework: E2EFramework; run(workspace: WorkspaceRef, runId: string): Promise<E2ERunResult>; }

export class PlaywrightRunner implements E2ERunner {
  readonly framework = "playwright" as const;
  async run(workspace: WorkspaceRef, runId: string): Promise<E2ERunResult> {
    await mkdir(join(workspace.root, "artifacts"), { recursive: true });
    const result = await runSafeCommand({
      executable: "playwright",
      args: ["test", "--reporter=line,junit,html"],
      cwd: workspace.root,
      env: { PLAYWRIGHT_HTML_OUTPUT_DIR: "artifacts/playwright-report", PLAYWRIGHT_JUNIT_OUTPUT_NAME: "artifacts/results.xml" },
      timeoutMs: 900_000,
    });
    await writeFile(join(workspace.root, "artifacts", "playwright.log"), `${result.stdout}\n${result.stderr}`);
    return {
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      summary: result.stdout.slice(-4000) || result.stderr.slice(-4000),
      artifacts: await discoverArtifacts(workspace.root, runId, "playwright"),
    };
  }
}

export class MaestroRunner implements E2ERunner {
  readonly framework = "maestro" as const;
  constructor(private readonly flowsPath = ".maestro") {}
  async run(workspace: WorkspaceRef, runId: string): Promise<E2ERunResult> {
    await mkdir(join(workspace.root, "artifacts"), { recursive: true });
    const result = await runSafeCommand({
      executable: "maestro",
      args: ["test", this.flowsPath, "--format", "junit", "--output", "artifacts/maestro.xml"],
      cwd: workspace.root,
      timeoutMs: 1_200_000,
    });
    await writeFile(join(workspace.root, "artifacts", "maestro.log"), `${result.stdout}\n${result.stderr}`);
    return {
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      summary: result.stdout.slice(-4000) || result.stderr.slice(-4000),
      artifacts: await discoverArtifacts(workspace.root, runId, "maestro"),
    };
  }
}

async function discoverArtifacts(root: string, runId: string, prefix: string): Promise<ArtifactRef[]> {
  const directory = join(root, "artifacts");
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter(entry => entry.isFile()).map(entry => ({
    absolute: join(entry.parentPath, entry.name),
    name: relative(directory, join(entry.parentPath, entry.name)),
  }));
  return files.map((file, index) => ({
    id: `${runId}:${prefix}:${index}`,
    kind: file.name.endsWith(".zip") ? "trace" as const : file.name.endsWith(".webm") || file.name.endsWith(".mp4") ? "video" as const : file.name.endsWith(".png") ? "screenshot" as const : file.name.endsWith(".log") ? "log" as const : "report" as const,
    name: file.name,
    uri: pathToFileURL(file.absolute).href,
  }));
}
