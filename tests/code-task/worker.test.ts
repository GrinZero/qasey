import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangedProjectPlaywrightVerification, CodeTaskState } from "../../packages/contracts/src/index.ts";
import { buildFreshDeviceBwrapArgs, type CodeTaskWorkerManifest } from "../../packages/code-task/src/index.ts";
import { assertContainedWorkspaceWritePath } from "../../packages/code-task/src/backend.ts";

const exec = promisify(execFile);
const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe("code-task-worker safety boundary", () => {
  it("verifies the outer worker namespace before reading one-shot credentials", async () => {
    const source = await readFile(resolve("src/sandbox/code-task-worker.ts"), "utf8");
    const isolationCheck = source.indexOf("await assertOuterWorkerIsolation();");
    const credentialRead = source.indexOf("const credentials = await receiveCredentials();");

    expect(isolationCheck).toBeGreaterThan(0);
    expect(credentialRead).toBeGreaterThan(isolationCheck);
    expect(source).toContain("/dev/qasey-host-device-sentinel");
    expect(source).toContain("/tmp/qasey-host-sentinel");
  });

  it("builds complete fresh-device bwrap namespaces and disables them for none isolation", () => {
    const args = buildFreshDeviceBwrapArgs({
      isolation: "bwrap",
      workspacePath: "/workspace",
      allowNetwork: false,
      readOnlyPaths: ["/runtime"],
      readWritePaths: ["/state"],
    });
    const hasPair = (flag: string, value: string) => args?.some((entry, index) => entry === flag && args[index + 1] === value) === true;

    expect(args).toEqual(expect.arrayContaining([
      "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--die-with-parent",
    ]));
    expect(hasPair("--proc", "/proc")).toBe(true);
    expect(hasPair("--dev", "/dev")).toBe(true);
    expect(hasPair("--tmpfs", "/dev/shm")).toBe(true);
    expect(hasPair("--tmpfs", "/tmp")).toBe(true);
    expect(hasPair("--ro-bind", "/runtime")).toBe(true);
    expect(hasPair("--bind", "/workspace")).toBe(true);
    expect(hasPair("--bind", "/state")).toBe(true);
    expect(hasPair("--chdir", "/workspace")).toBe(true);
    for (const hostDeviceBindFlag of ["--bind", "--bind-try", "--ro-bind", "--ro-bind-try", "--dev-bind", "--dev-bind-try"]) {
      expect(hasPair(hostDeviceBindFlag, "/dev")).toBe(false);
    }

    expect(buildFreshDeviceBwrapArgs({
      isolation: "bwrap",
      workspacePath: "/workspace",
      allowNetwork: true,
    })).not.toContain("--unshare-net");
    expect(buildFreshDeviceBwrapArgs({
      isolation: "none",
      workspacePath: "/workspace",
      allowNetwork: false,
    })).toBeUndefined();
  });

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

  it("rejects a write whose nearest existing ancestor is an escaping symlink", async () => {
    const root = await createRepository();
    const outside = join(root.repositoryRoot, "outside");
    await mkdir(outside);
    await symlink(outside, join(root.workspaceRoot, "generated"));
    await expect(assertContainedWorkspaceWritePath(root.workspaceRoot, "generated/result.txt"))
      .rejects.toThrow(/ancestor symlink outside/iu);
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

  it("fails closed when a changed path is outside the frozen Playwright projects", async () => {
    const root = await createRepository();
    await writeFile(join(root.workspaceRoot, "tests", "example.spec.ts"), "export const marker = 'uncovered';\n");
    const execution = await runWorker(root, "uncovered-attempt", false, [{ id: "playwright" }], {
      strategy: "changed-project-playwright",
      projects: [{
        id: "web",
        root: "web",
        testRoot: "web/tests",
        config: "web/playwright.config.ts",
        playwrightProject: "chromium",
      }],
    });

    expect(execution.state).toMatchObject({ status: "failed" });
    expect(execution.state.result?.summary).toMatch(/not covered by a fixed Playwright project/u);
  });
});

async function runVerifierAttempt(marker: string) {
  const root = await createRepository();
  await writeFile(join(root.workspaceRoot, "tests", "example.spec.ts"), `export const marker = ${JSON.stringify(marker)};\n`);
  const execution = await runWorker(root, `${marker}-attempt`, true);
  const patchRef = execution.state.result?.patchRef;
  if (!patchRef) throw new Error("worker did not produce a patch");
  return { ...execution, patch: await readFile(join(execution.artifactRoot, "changes.patch"), "utf8") };
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
  playwrightVerification?: ChangedProjectPlaywrightVerification,
): Promise<{ state: CodeTaskState; workspaceRoot: string; artifactRoot: string; events: Array<{ metadata: Record<string, unknown> }> }> {
  const taskRoot = root.repositoryRoot;
  const controlRoot = join(taskRoot, "control", attemptId);
  const artifactRoot = join(taskRoot, "artifacts", attemptId);
  const checkRoot = join(taskRoot, "check-output", attemptId);
  const statePath = join(controlRoot, "state.json");
  const eventsPath = join(controlRoot, "events.ndjson");
  const manifestPath = join(controlRoot, "manifest.json");
  await Promise.all([
    mkdir(dirname(manifestPath), { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
    mkdir(checkRoot, { recursive: true }),
  ]);
  const context = JSON.stringify({ purpose: "deterministic verifier smoke test" });
  const manifest: CodeTaskWorkerManifest = {
    spec: {
      taskId: "worker-test", attemptId, kind: "author",
      scope: { applicationId: "qasey", tenantId: "tenant", sessionId: "session" },
      contextRef: { id: "context", kind: "report", name: "context.json", uri: "file:///context.json" },
      contextHash: createHash("sha256").update(context).digest("hex"),
      repositories: [{ owner: "example-org", repository: "web-e2e", destination: "target", mode: "write", baseRef: "main", baseSha: root.baseSha }],
      baseSha: root.baseSha, executionProfileId: "web-e2e-verifier", allowedPaths: ["tests"], fixedChecks, deadlineMs: 60_000,
      traceContext: { traceId: "trace-worker-test" },
      ...(playwrightVerification ? { playwrightVerification } : {}),
    },
    context,
    workspaceRoot: root.workspaceRoot,
    taskRoot,
    controlRoot,
    artifactRoot,
    artifactUriPrefix: `sandbox://code-task-artifacts/worker-test/${attemptId}`,
    checkRoot,
    isolation: "none",
    checkRuntimeReadOnlyPaths: [],
    statePath,
    eventsPath,
    repositoryMounts: [{ root: root.workspaceRoot, mode: "write", baseSha: root.baseSha }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    await executeWorker(manifestPath);
    if (!expectSuccess) throw new Error("worker unexpectedly succeeded");
  } catch (error) {
    if (expectSuccess) {
      const state = await readFile(statePath, "utf8").then(value => JSON.parse(value) as CodeTaskState).catch(() => undefined);
      throw new Error(`worker failed: ${state?.result?.summary ?? state?.error ?? String(error)}`);
    }
  }
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { metadata: Record<string, unknown> });
  return { state: JSON.parse(await readFile(statePath, "utf8")) as CodeTaskState, workspaceRoot: root.workspaceRoot, artifactRoot, events };
}

async function executeWorker(manifestPath: string): Promise<void> {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && key !== "OPENAI_API_KEY" && key !== "OPENAI_BASE_URL")) as NodeJS.ProcessEnv;
  environment.QASEY_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
  const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("src/sandbox/code-task-worker.ts"), manifestPath], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  // The runtime sends one line but deliberately does not own a long-lived
  // credential channel. The worker must consume and close its stdin itself so
  // an open parent pipe cannot keep a terminal task alive.
  child.stdin.write("{}\n");
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker did not exit after consuming its one-shot credential line"));
    }, 15_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => { clearTimeout(timeout); resolveExit(code); });
  });
  if (exitCode !== 0) throw new Error(`worker exited with ${exitCode}: ${stderr || stdout}`);
}
