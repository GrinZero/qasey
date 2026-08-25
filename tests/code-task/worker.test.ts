import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeTaskState } from "../../packages/contracts/src/index.ts";
import type { CodeTaskWorkerManifest } from "../../packages/code-task/src/index.ts";

const exec = promisify(execFile);
const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe("code-task-worker safety boundary", () => {
  it("keeps two attempts in independent repositories and emits independent patches", async () => {
    const first = await runVerifierAttempt("first");
    const second = await runVerifierAttempt("second");

    expect(first.state.result).toMatchObject({ status: "succeeded", changedPaths: ["tests/example.spec.ts"] });
    expect(second.state.result).toMatchObject({ status: "succeeded", changedPaths: ["tests/example.spec.ts"] });
    expect(first.patch).toContain("first");
    expect(first.patch).not.toContain("second");
    expect(second.patch).toContain("second");
    expect(second.patch).not.toContain("first");
    expect(first.workspaceRoot).not.toBe(second.workspaceRoot);
    expect(first.events.every(event => event.metadata.traceId === "trace-worker-test" && event.metadata.contextHash)).toBe(true);
  });

  it("rejects a changed symlink that resolves outside the attempt workspace", async () => {
    const root = await createRepository();
    await symlink("/etc/hosts", join(root.workspaceRoot, "tests", "leak"));
    const execution = await runWorker(root, "symlink-attempt", false);
    expect(execution.state).toMatchObject({ status: "failed" });
    expect(execution.state.result?.summary).toMatch(/outside|symlink/iu);
  });

  it("hydrates dependencies with lifecycle scripts disabled", async () => {
    const root = await createRepository();
    const marker = join(root.repositoryRoot, "postinstall-escaped.txt");
    await writeFile(join(root.workspaceRoot, "package.json"), JSON.stringify({
      name: "malicious-fixture", private: true, scripts: { postinstall: `node -e \"require('fs').writeFileSync(${JSON.stringify(marker)}, 'escaped')\"` },
    }));
    await exec("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root.workspaceRoot });
    await exec("git", ["add", "."], { cwd: root.workspaceRoot });
    await exec("git", ["commit", "-qm", "add package fixture"], { cwd: root.workspaceRoot });
    root.baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: root.workspaceRoot })).stdout.trim();
    await writeFile(join(root.workspaceRoot, "tests", "example.spec.ts"), "export const marker = 'safe install';\n");

    const execution = await runWorker(root, "postinstall-attempt", true, [{ id: "repo-install" }]);

    expect(execution.state).toMatchObject({ status: "succeeded" });
    await expect(access(marker)).rejects.toThrow();
  });
});

async function runVerifierAttempt(marker: string) {
  const root = await createRepository();
  await writeFile(join(root.workspaceRoot, "tests", "example.spec.ts"), `export const marker = ${JSON.stringify(marker)};\n`);
  const execution = await runWorker(root, `${marker}-attempt`, true);
  const patchRef = execution.state.result?.patchRef;
  if (!patchRef) throw new Error("worker did not produce a patch");
  return { ...execution, patch: await readFile(resolve(root.repositoryRoot, patchRef.uri.slice("sandbox://".length)), "utf8") };
}

async function createRepository() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "qasey-code-task-worker-"));
  cleanups.push(repositoryRoot);
  const workspaceRoot = join(repositoryRoot, "repositories", "target");
  await mkdir(join(workspaceRoot, "tests"), { recursive: true });
  await writeFile(join(workspaceRoot, "tests", "example.spec.ts"), "export const marker = 'base';\n");
  await exec("git", ["init", "-q"], { cwd: workspaceRoot });
  await exec("git", ["config", "user.email", "qasey@example.test"], { cwd: workspaceRoot });
  await exec("git", ["config", "user.name", "Qasey Test"], { cwd: workspaceRoot });
  await exec("git", ["add", "."], { cwd: workspaceRoot });
  await exec("git", ["commit", "-qm", "base"], { cwd: workspaceRoot });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot });
  return { repositoryRoot, workspaceRoot, baseSha: stdout.trim() };
}

async function runWorker(
  root: Awaited<ReturnType<typeof createRepository>>,
  attemptId: string,
  expectSuccess: boolean,
  fixedChecks: Array<{ id: string }> = [],
): Promise<{ state: CodeTaskState; workspaceRoot: string; events: Array<{ metadata: Record<string, unknown> }> }> {
  const taskRoot = join(root.repositoryRoot, "code-tasks", "worker-test", attemptId);
  const statePath = join(taskRoot, "state.json");
  const eventsPath = join(taskRoot, "events.ndjson");
  const manifestPath = join(taskRoot, "manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  const context = JSON.stringify({ purpose: "deterministic verifier smoke test" });
  const manifest: CodeTaskWorkerManifest = {
    spec: {
      taskId: "worker-test", attemptId, kind: "author",
      scope: { applicationId: "qasey", tenantId: "tenant", sessionId: "session" },
      contextRef: { id: "context", kind: "report", name: "context.json", uri: "file:///context.json" },
      contextHash: createHash("sha256").update(context).digest("hex"),
      repositories: [{ owner: "MoeGolibrary", repository: "moego-e2e-autotest", destination: "target", mode: "write", baseRef: "main", baseSha: root.baseSha }],
      baseSha: root.baseSha, executionProfileId: "web-e2e-verifier", allowedPaths: ["tests"], fixedChecks, deadlineMs: 60_000,
      traceContext: { traceId: "trace-worker-test" },
    },
    context, repositoryRoot: root.repositoryRoot, workspaceRoot: root.workspaceRoot, taskRoot, statePath, eventsPath,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    await exec(resolve("node_modules/.bin/tsx"), [resolve("src/sandbox/code-task-worker.ts"), manifestPath], {
      cwd: process.cwd(), env: { ...process.env, QASEY_IMAGE_DIGEST: "sha256:test" },
    });
    if (!expectSuccess) throw new Error("worker unexpectedly succeeded");
  } catch (error) {
    if (expectSuccess) {
      const state = await readFile(statePath, "utf8").then(value => JSON.parse(value) as CodeTaskState).catch(() => undefined);
      throw new Error(`worker failed: ${state?.result?.summary ?? state?.error ?? String(error)}`);
    }
  }
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { metadata: Record<string, unknown> });
  return { state: JSON.parse(await readFile(statePath, "utf8")) as CodeTaskState, workspaceRoot: root.workspaceRoot, events };
}
