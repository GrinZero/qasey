import { createHash } from "node:crypto";
import { access, appendFile, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LocalSandbox } from "@mastra/core/workspace";
import {
  CodeTaskResultSchema,
  CodeTaskStateSchema,
  type ArtifactRef,
  type CheckResult,
  type CodeTaskChange,
  type CodeTaskEvent,
  type CodeTaskResult,
  type CodeTaskState,
} from "../../packages/contracts/src/index.ts";
import {
  buildFreshDeviceBwrapArgs,
  CodeTaskWorkerManifestSchema,
  CodeTaskWorkerCredentialsSchema,
  NativeMastraCodingBackend,
  executionProfile,
  executionProfileHash,
  writeCodeTaskState,
} from "../../packages/code-task/src/index.ts";
import { runSafeCommand } from "../../packages/e2e/src/process.ts";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("code-task-worker requires a manifest path");
const manifest = CodeTaskWorkerManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
await rm(manifestPath, { force: true });
const { spec } = manifest;
const canonicalWorkspaceRoot = await realpath(manifest.workspaceRoot);
const profile = executionProfile(spec.executionProfileId);
const imageDigest = codeTaskImageDigest(process.env.QASEY_IMAGE_DIGEST);
await assertOuterWorkerIsolation();
const credentials = await receiveCredentials();
let cursor = 0;
let checkSandbox: LocalSandbox | undefined;
let readOnlyRepositorySnapshots: RepositoryIntegritySnapshot[] = [];
const abortController = new AbortController();
process.once("SIGTERM", () => abortController.abort(new Error("Code task cancelled")));
process.once("SIGINT", () => abortController.abort(new Error("Code task cancelled")));

await emit("task.started", `Starting ${spec.executionProfileId}`);
const createdAt = new Date().toISOString();
await writeState({ taskId: spec.taskId, attemptId: spec.attemptId, status: "running", createdAt, updatedAt: createdAt });

try {
  verifyContextIntegrity(manifest.context, spec.contextHash);
  readOnlyRepositorySnapshots = await validateRepositoryMounts();
  if (manifest.inputPatchPath) await applyInputPatch(manifest.inputPatchPath);
  const initialPaths = await changedPaths(manifest.workspaceRoot);
  let agentSummary = "Deterministic execution profile; no coding agent was started.";
  if (profile.useAgent) {
    await emit("agent.started", "Starting native Mastra coding agent");
    agentSummary = await runAgent();
    await emit("agent.completed", "Native Mastra coding agent completed");
  }
  abortController.signal.throwIfAborted();
  const pathsForChecks = await changedPaths(manifest.workspaceRoot);
  const checks = await runChecks(pathsForChecks);
  const finalPaths = await changedPaths(manifest.workspaceRoot);
  await assertReadOnlyRepositoriesUnchanged(readOnlyRepositorySnapshots);
  if (profile.id === "code-review-readonly" && finalPaths.length > initialPaths.length) {
    throw new Error("Read-only code review modified the repository");
  }
  await assertAllowedChanges(finalPaths);
  const patchRef = profile.writable || profile.id === "web-e2e-verifier"
    ? await collectPatch(finalPaths)
    : undefined;
  const changes = await collectChanges(finalPaths);
  const passed = checks.every(check => check.passed);
  const result = CodeTaskResultSchema.parse({
    status: passed ? "succeeded" : "failed",
    summary: passed ? agentSummary : `${agentSummary}\n${checks.filter(check => !check.passed).map(check => check.summary).join("\n")}`,
    changedPaths: finalPaths,
    changes,
    ...(patchRef ? { patchRef } : {}),
    checks,
    artifacts: [...checks.flatMap(check => check.artifacts), ...(patchRef ? [patchRef] : []), ...changes.flatMap(change => change.contentRef ? [change.contentRef] : [])],
    provenance: provenance(),
  });
  await finish(result);
} catch (error) {
  const cancelled = abortController.signal.aborted;
  if (cancelled) await emitCancellationRequestFromState();
  const integrityError = await assertReadOnlyRepositoriesUnchanged(readOnlyRepositorySnapshots)
    .then(() => undefined, failure => failure instanceof Error ? failure : new Error(String(failure)));
  const result = CodeTaskResultSchema.parse({
    status: cancelled ? "cancelled" : "failed",
    summary: safeText(integrityError?.message ?? (error instanceof Error ? error.message : String(error))),
    changedPaths: await changedPaths(manifest.workspaceRoot).catch(() => []),
    changes: [],
    checks: [],
    artifacts: [],
    provenance: provenance(),
  });
  await finish(result);
  if (!cancelled) process.exitCode = 1;
} finally {
  await checkSandbox?._destroy().catch(() => undefined);
}

async function runAgent(): Promise<string> {
  const output = await new NativeMastraCodingBackend().run({
    taskId: spec.taskId,
    workspaceRoot: manifest.workspaceRoot,
    context: manifest.context,
    allowedPaths: spec.allowedPaths,
    profile,
    traceContext: spec.traceContext,
    credentials: {
      ...(credentials.openaiApiKey ? { openaiApiKey: credentials.openaiApiKey } : {}),
      ...(credentials.openaiBaseUrl ? { openaiBaseUrl: credentials.openaiBaseUrl } : {}),
    },
    abortSignal: abortController.signal,
  });
  await emit("agent.backend", "Native Mastra Agent run associated", { backendRunId: output.backendRunId });
  return safeText(output.summary);
}

async function runChecks(paths: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of spec.fixedChecks) {
    if (!profile.allowedCheckIds.includes(check.id)) throw new Error(`Check ${check.id} is not allowed by ${profile.id}`);
    abortController.signal.throwIfAborted();
    await emit("check.started", `Running fixed check ${check.id}`, { checkId: check.id });
    const result = check.id === "repo-install"
      ? await runRepositoryInstall()
      : check.id === "playwright"
        ? await runPlaywrightCheck(paths)
        : undefined;
    if (!result) throw new Error(`Unknown fixed check: ${check.id}`);
    results.push(result);
    await emit("check.completed", `Fixed check ${check.id} ${result.passed ? "passed" : "failed"}`, { checkId: check.id, exitCode: result.exitCode });
  }
  return results;
}

async function runRepositoryInstall(): Promise<CheckResult> {
  const command = await detectInstallCommand();
  if (!command) {
    return {
      id: "repo-install",
      passed: true,
      exitCode: 0,
      summary: "No supported lockfile was found; dependency installation was skipped.",
      durationMs: 0,
      artifacts: [],
    };
  }
  const result = await runFixedCheckCommand({
    executable: command.executable,
    args: command.args,
    cwd: manifest.workspaceRoot,
    timeoutMs: Math.min(spec.deadlineMs, 10 * 60_000),
  });
  const logPath = join(manifest.artifactRoot, "repo-install.log");
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, safeText(`${result.stdout}\n${result.stderr}`, 2_000_000), { mode: 0o600 });
  return {
    id: "repo-install",
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    summary: safeText(result.stdout.slice(-4_000) || result.stderr.slice(-4_000) || `${command.executable} completed`),
    durationMs: result.durationMs,
    artifacts: [{ id: `${spec.taskId}:repo-install-log`, kind: "log", name: "repo-install.log", uri: sandboxUri(logPath), contentType: "text/plain" }],
  };
}

async function detectInstallCommand(): Promise<{ executable: string; args: string[] } | undefined> {
  if (await exists(join(manifest.workspaceRoot, "pnpm-lock.yaml"))) {
    return { executable: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"] };
  }
  if (await exists(join(manifest.workspaceRoot, "yarn.lock"))) {
    return { executable: "corepack", args: ["yarn", "install", "--immutable", "--mode=skip-builds"] };
  }
  if (await exists(join(manifest.workspaceRoot, "package-lock.json"))) {
    return { executable: "npm", args: ["ci", "--ignore-scripts"] };
  }
  return undefined;
}

interface FixedCheckCommandInput {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

async function runFixedCheckCommand(input: FixedCheckCommandInput): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const sandbox = await fixedCheckSandbox();
  if (!sandbox.executeCommand) throw new Error("Fixed-check sandbox does not support command execution");
  const result = await sandbox.executeCommand(input.executable, input.args, {
    cwd: input.cwd,
    ...(input.env ? { env: input.env } : {}),
    timeout: input.timeoutMs,
    maxRetainedBytes: 2_000_000,
    abortSignal: abortController.signal,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.executionTimeMs,
  };
}

async function fixedCheckSandbox(): Promise<LocalSandbox> {
  if (checkSandbox) return checkSandbox;
  await Promise.all([
    mkdir(join(manifest.checkRoot, "home", ".config"), { recursive: true, mode: 0o700 }),
    mkdir(join(manifest.checkRoot, "home", ".cache"), { recursive: true, mode: 0o700 }),
    mkdir(join(manifest.checkRoot, "home", ".local", "share"), { recursive: true, mode: 0o700 }),
  ]);
  const primary = manifest.repositoryMounts.find(mount => resolve(mount.root) === resolve(manifest.workspaceRoot));
  if (!primary) throw new Error("Primary repository is missing from the fixed-check mount manifest");
  const checkReadOnlyPaths = [
    ...manifest.checkRuntimeReadOnlyPaths,
    ...manifest.repositoryMounts.filter(mount => mount !== primary && mount.mode === "read").map(mount => mount.root),
  ];
  const checkReadWritePaths = [
    manifest.checkRoot,
    ...(manifest.packageStoreRoot ? [manifest.packageStoreRoot] : []),
    ...manifest.repositoryMounts.filter(mount => mount !== primary && mount.mode === "write").map(mount => mount.root),
  ];
  const checkBwrapArgs = buildFreshDeviceBwrapArgs({
    isolation: manifest.isolation,
    workspacePath: manifest.workspaceRoot,
    allowNetwork: true,
    readOnly: primary.mode === "read",
    readOnlyPaths: checkReadOnlyPaths,
    readWritePaths: checkReadWritePaths,
  });
  const sandbox = new LocalSandbox({
    id: `qasey-fixed-check-${spec.taskId}-${spec.attemptId}`,
    workingDirectory: manifest.workspaceRoot,
    timeout: spec.deadlineMs,
    isolation: manifest.isolation,
    env: fixedCheckEnvironment(manifest.checkRoot),
    nativeSandbox: {
      allowNetwork: true,
      allowSystemBinaries: true,
      readOnly: primary.mode === "read",
      readOnlyPaths: checkReadOnlyPaths,
      readWritePaths: checkReadWritePaths,
      ...(checkBwrapArgs ? { bwrapArgs: checkBwrapArgs } : {}),
    },
  });
  await sandbox._start();
  checkSandbox = sandbox;
  return sandbox;
}

async function runPlaywrightCheck(paths: string[]): Promise<CheckResult> {
  const checkOutputRoot = join(manifest.checkRoot, "playwright");
  await mkdir(checkOutputRoot, { recursive: true });
  const plans = playwrightPlans(paths);
  await validateCaseMappings(paths);
  const artifacts: ArtifactRef[] = [];
  const summaries: string[] = [];
  let passed = true;
  let exitCode = 0;
  let durationMs = 0;
  for (const plan of plans) {
    abortController.signal.throwIfAborted();
    const planRoot = join(checkOutputRoot, plan.id);
    const artifactPlanRoot = join(manifest.artifactRoot, "playwright", plan.id);
    await mkdir(planRoot, { recursive: true });
    await mkdir(artifactPlanRoot, { recursive: true });
    const result = await runFixedCheckCommand({
      executable: "pnpm",
      args: [
        "exec", "playwright", "test", ...plan.testFiles,
        ...(plan.config ? [`--config=${plan.config}`] : []),
        ...(plan.playwrightProject ? [`--project=${plan.playwrightProject}`] : []),
        "--reporter=line,json,html", "--output", join(planRoot, "test-results"),
      ],
      cwd: manifest.workspaceRoot,
      env: {
        ...fixedCheckEnvironment(manifest.checkRoot),
        PLAYWRIGHT_HTML_OUTPUT_DIR: join(planRoot, "html-report"),
        PLAYWRIGHT_JSON_OUTPUT_NAME: join(planRoot, "results.json"),
      },
      timeoutMs: Math.min(spec.deadlineMs, 15 * 60_000),
    });
    const logPath = join(artifactPlanRoot, "playwright.log");
    await writeFile(logPath, safeText(`${result.stdout}\n${result.stderr}`, 2_000_000), { mode: 0o600 });
    artifacts.push({ id: `${spec.taskId}:playwright-${plan.id}-log`, kind: "log", name: `${plan.id}-playwright.log`, uri: sandboxUri(logPath), contentType: "text/plain" });
    const jsonReport = join(planRoot, "results.json");
    if (await exists(jsonReport)) {
      const artifactJsonReport = join(artifactPlanRoot, "results.json");
      await copyFile(jsonReport, artifactJsonReport);
      artifacts.push({ id: `${spec.taskId}:playwright-${plan.id}-json`, kind: "report", name: `${plan.id}-results.json`, uri: sandboxUri(artifactJsonReport), contentType: "application/json" });
    }
    artifacts.push(...await collectPlaywrightArtifacts(plan.id, join(planRoot, "html-report"), join(artifactPlanRoot, "html-report"), "report"));
    artifacts.push(...await collectPlaywrightArtifacts(plan.id, join(planRoot, "test-results"), join(artifactPlanRoot, "test-results"), "trace"));
    passed &&= result.exitCode === 0;
    if (exitCode === 0 && result.exitCode !== 0) exitCode = result.exitCode;
    durationMs += result.durationMs;
    summaries.push(`${plan.id}: ${safeText(result.stdout.slice(-4_000) || result.stderr.slice(-4_000) || "Playwright completed")}`);
  }
  return {
    id: "playwright",
    passed,
    exitCode,
    summary: safeText(summaries.join("\n\n")),
    durationMs,
    artifacts,
  };
}

async function collectPlaywrightArtifacts(planId: string, sourceRoot: string, destinationRoot: string, fallbackKind: ArtifactRef["kind"]): Promise<ArtifactRef[]> {
  if (!await exists(sourceRoot)) return [];
  const output: ArtifactRef[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(source); continue; }
      if (!entry.isFile()) continue;
      const path = relative(sourceRoot, source);
      const destination = join(destinationRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      const kind: ArtifactRef["kind"] = /\.webm$/iu.test(path) ? "video"
        : /\.png$|\.jpe?g$/iu.test(path) ? "screenshot"
          : /trace\.zip$/iu.test(path) ? "trace" : fallbackKind;
      output.push({
        id: `${spec.taskId}:playwright-${planId}-${sha256(path).slice(0, 16)}`,
        kind,
        name: `${planId}/${path.replaceAll("\\", "/")}`,
        uri: sandboxUri(destination),
        contentType: kind === "video" ? "video/webm" : kind === "screenshot" ? "image/png" : undefined,
      });
    }
  }
  await visit(sourceRoot);
  return output;
}

async function validateCaseMappings(paths: string[]): Promise<void> {
  const context = JSON.parse(manifest.context) as { brief?: { cases?: Array<{ id?: string; versionHash?: string; automationPath?: string }> } };
  const cases = context.brief?.cases ?? [];
  for (const path of paths.filter(path => /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path))) {
    const source = await readFile(join(manifest.workspaceRoot, path), "utf8");
    if (/\btest\.(?:only|skip)\s*\(/u.test(source)) throw new Error(`${path}: test.only and test.skip are forbidden`);
    if (!/\bexpect\s*\(/u.test(source)) throw new Error(`${path}: Playwright case must contain a meaningful assertion`);
  }
  for (const testCase of cases) {
    if (!testCase.id || !testCase.versionHash || !testCase.automationPath) continue;
    const source = await readFile(join(manifest.workspaceRoot, testCase.automationPath), "utf8");
    const caseAnnotations = [...source.matchAll(/type:\s*["']qasey\.case["']\s*,\s*description:\s*["']([^"']+)["']/gu)]
      .filter(match => match[1] === testCase.id);
    if (caseAnnotations.length !== 1) throw new Error(`${testCase.automationPath}: expected exactly one qasey.case annotation for ${testCase.id}`);
    const versionAnnotations = [...source.matchAll(/type:\s*["']qasey\.version["']\s*,\s*description:\s*["']([^"']+)["']/gu)]
      .filter(match => match[1] === testCase.versionHash);
    if (versionAnnotations.length !== 1) throw new Error(`${testCase.automationPath}: qasey.version does not match ${testCase.versionHash}`);
    if (!source.includes(testCase.id)) throw new Error(`${testCase.automationPath}: test title must include ${testCase.id}`);
  }
}

interface PlaywrightPlan {
  id: string;
  config: string;
  playwrightProject: string;
  testFiles: string[];
}

function playwrightPlans(paths: string[]): PlaywrightPlan[] {
  const verification = spec.playwrightVerification;
  if (!verification) {
    throw new Error("Playwright fixed checks require a server-frozen verification mapping");
  }
  const uncovered = paths.filter(path => !verification.projects.some(project => isWithinWorkspacePath(path, project.root)));
  if (uncovered.length > 0) {
    throw new Error(`Changed paths are not covered by a fixed Playwright project: ${uncovered.join(", ")}`);
  }
  const affected = verification.projects.filter(project =>
    paths.some(path => isWithinWorkspacePath(path, project.root)),
  );
  if (affected.length === 0) {
    throw new Error(`No fixed Playwright project matches changed paths: ${paths.join(", ") || "none"}`);
  }
  return affected.map(project => ({
    id: project.id,
    config: project.config,
    playwrightProject: project.playwrightProject,
    testFiles: paths.filter(path =>
      isWithinWorkspacePath(path, project.testRoot) && /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path),
    ),
  }));
}

function isWithinWorkspacePath(path: string, root: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

async function collectPatch(paths: string[]): Promise<ArtifactRef | undefined> {
  if (paths.length === 0) {
    if (profile.id === "web-e2e-verifier") throw new Error("Verifier received an empty patch");
    throw new Error("Coding task produced no repository changes");
  }
  const addIntent = await runSafeCommand({ executable: "git", args: ["add", "-N", "--", ...paths], cwd: manifest.workspaceRoot });
  if (addIntent.exitCode !== 0) throw new Error(`git add -N failed: ${safeText(addIntent.stderr)}`);
  const patch = await runSafeCommand({ executable: "git", args: ["diff", "HEAD", "--binary", "--", ...spec.allowedPaths], cwd: manifest.workspaceRoot });
  if (patch.exitCode !== 0 || !patch.stdout.trim()) throw new Error(`git diff failed or returned an empty patch: ${safeText(patch.stderr)}`);
  const target = join(manifest.artifactRoot, "changes.patch");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, patch.stdout, { mode: 0o600 });
  return { id: `${spec.taskId}:patch`, kind: "patch", name: "changes.patch", uri: sandboxUri(target), contentType: "text/x-diff", sha256: sha256(patch.stdout) };
}

async function collectChanges(paths: string[]): Promise<CodeTaskChange[]> {
  const status = await gitNameStatus();
  const changes: CodeTaskChange[] = [];
  for (const path of paths) {
    const statusName = status.get(path) ?? "modified";
    if (statusName === "deleted") { changes.push({ path, status: statusName }); continue; }
    const source = resolveContained(manifest.workspaceRoot, path);
    const stats = await lstat(source);
    const mode = stats.isSymbolicLink() ? "120000" as const : stats.mode & 0o111 ? "100755" as const : "100644" as const;
    const target = join(manifest.artifactRoot, "files", `${String(changes.length).padStart(4, "0")}.bin`);
    await mkdir(dirname(target), { recursive: true });
    if (stats.isSymbolicLink()) await writeFile(target, await readlink(source), { mode: 0o600 });
    else await copyFile(source, target);
    changes.push({
      path,
      status: statusName,
      mode,
      contentRef: { id: `${spec.taskId}:file:${changes.length}`, kind: "report", name: path, uri: sandboxUri(target), sha256: sha256(await readFile(target)) },
    });
  }
  return changes;
}

async function assertAllowedChanges(paths: string[]): Promise<void> {
  for (const path of paths) {
    const normalized = relative(manifest.workspaceRoot, resolveContained(manifest.workspaceRoot, path));
    if (!spec.allowedPaths.some(allowed => normalized === allowed || normalized.startsWith(`${allowed}/`))) {
      throw new Error(`Path is outside allowedPaths: ${normalized}`);
    }
    const index = await runSafeCommand({ executable: "git", args: ["ls-files", "-s", "--", path], cwd: manifest.workspaceRoot });
    if (/^160000\s/u.test(index.stdout)) throw new Error(`Submodule changes are not allowed: ${path}`);
    const stats = await lstat(resolveContained(manifest.workspaceRoot, path)).catch(() => undefined);
    const boundary = await realpath(stats ? resolveContained(manifest.workspaceRoot, path) : dirname(resolveContained(manifest.workspaceRoot, path))).catch(() => "");
    if (!boundary || (boundary !== canonicalWorkspaceRoot && !boundary.startsWith(`${canonicalWorkspaceRoot}${sep}`))) {
      throw new Error(`Path resolves outside the task workspace: ${path}`);
    }
    if (stats?.isSymbolicLink()) {
      if (boundary !== canonicalWorkspaceRoot && !boundary.startsWith(`${canonicalWorkspaceRoot}${sep}`)) throw new Error(`Symlink escapes workspace: ${path}`);
    }
    if (stats?.isDirectory() && await exists(join(resolveContained(manifest.workspaceRoot, path), ".git"))) {
      throw new Error(`Embedded Git repository changes are not allowed: ${path}`);
    }
  }
}

async function changedPaths(root: string): Promise<string[]> {
  const result = await runSafeCommand({ executable: "git", args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd: root });
  if (result.exitCode !== 0) throw new Error(`git status failed: ${safeText(result.stderr)}`);
  const entries = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const first = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const source = entries[++index];
      if (first) paths.push(first);
      if (source) paths.push(source);
    } else if (first) paths.push(first);
  }
  return [...new Set(paths)].filter(path => !isRuntimeGeneratedPath(path)).sort();
}

async function gitNameStatus(): Promise<Map<string, CodeTaskChange["status"]>> {
  const paths = await changedPaths(manifest.workspaceRoot);
  await runSafeCommand({ executable: "git", args: ["add", "-N", "--", ...paths], cwd: manifest.workspaceRoot });
  const result = await runSafeCommand({ executable: "git", args: ["diff", "--name-status", "-z", "HEAD", "--", ...spec.allowedPaths], cwd: manifest.workspaceRoot });
  if (result.exitCode !== 0) throw new Error(`git diff --name-status failed: ${safeText(result.stderr)}`);
  const tokens = result.stdout.split("\0").filter(Boolean);
  const values = new Map<string, CodeTaskChange["status"]>();
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const source = tokens[index++];
      const target = tokens[index++];
      if (source) values.set(source, "deleted");
      if (target) values.set(target, "renamed");
      continue;
    }
    const path = tokens[index++];
    if (path) values.set(path, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified");
  }
  return values;
}

async function finish(result: CodeTaskResult): Promise<void> {
  const now = new Date().toISOString();
  await writeState({ taskId: spec.taskId, attemptId: spec.attemptId, status: result.status, createdAt, updatedAt: now, result });
  await emit("task.completed", `Code task ${result.status}`, { status: result.status });
}

async function emitCancellationRequestFromState(): Promise<void> {
  const state = await readFile(manifest.statePath, "utf8")
    .then(value => CodeTaskStateSchema.parse(JSON.parse(value)))
    .catch(() => undefined);
  if (state?.status !== "cancel_requested") return;
  await emit("task.cancel_requested", "Code task cancellation requested", {
    ...(state.error ? { reason: state.error } : {}),
  });
}

async function writeState(state: CodeTaskState): Promise<void> {
  await writeCodeTaskState(manifest.statePath, state);
}

async function emit(type: string, message: string, metadata: Record<string, unknown> = {}): Promise<void> {
  cursor += 1;
  const event: CodeTaskEvent = {
    cursor: String(cursor), taskId: spec.taskId, at: new Date().toISOString(), type, message: safeText(message),
    metadata: { ...spec.traceContext, contextHash: spec.contextHash, attemptId: spec.attemptId, ...metadata },
  };
  await mkdir(dirname(manifest.eventsPath), { recursive: true });
  await appendFile(manifest.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function verifyContextIntegrity(context: string, expected: string): void {
  if (sha256(context) !== expected) throw new Error("Code task context hash did not match its immutable context");
}

function provenance() {
  return {
    imageDigest,
    profileHash: executionProfileHash(profile),
    agentBackend: "native-mastra" as const,
    mastraVersion: process.env.QASEY_MASTRA_VERSION?.trim() || "unverified",
    model: process.env.QASEY_CODE_AGENT_MODEL?.trim() || "gpt-5.6-sol",
  };
}

function codeTaskImageDigest(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return "unverified-image";
  if (!/^sha256:[a-f0-9]{64}$/u.test(configured)) {
    throw new Error("QASEY_IMAGE_DIGEST must be an immutable sha256 OCI image digest");
  }
  return configured;
}

function sandboxUri(path: string): string {
  const rel = relative(manifest.artifactRoot, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(manifest.artifactRoot, rel) !== resolve(path)) {
    throw new Error("Artifact escaped the Code Task artifact root");
  }
  return `${manifest.artifactUriPrefix}/${rel.split(sep).join("/")}`;
}

function resolveContained(rootInput: string, path: string): string {
  const root = resolve(rootInput);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`Path escaped task workspace: ${path}`);
  return target;
}

interface RepositoryIntegritySnapshot {
  root: string;
  head: string;
  status: string;
  refs: string;
  localConfig: string;
}

async function validateRepositoryMounts(): Promise<RepositoryIntegritySnapshot[]> {
  const repositoriesRoot = await realpath(join(manifest.taskRoot, "repositories"));
  const canonicalRoots = new Set<string>();
  const snapshots: RepositoryIntegritySnapshot[] = [];
  let primaryFound = false;
  for (const mount of manifest.repositoryMounts) {
    const root = await realpath(mount.root);
    assertRealPathContained(repositoriesRoot, root, "Repository mount escaped the task repository root");
    if (canonicalRoots.has(root)) throw new Error(`Duplicate repository mount: ${root}`);
    canonicalRoots.add(root);
    if (root === canonicalWorkspaceRoot) primaryFound = true;
    const gitMetadata = await lstat(join(root, ".git"));
    if (!gitMetadata.isDirectory()) throw new Error(`Repository ${root} does not own an independent .git directory`);
    if (await exists(join(root, ".git", "objects", "info", "alternates"))) {
      throw new Error(`Repository ${root} references a shared Git object store`);
    }
    const head = (await checkedGit(root, ["rev-parse", "HEAD"])).trim();
    if (head !== mount.baseSha) throw new Error(`Repository ${root} HEAD ${head} did not match pinned SHA ${mount.baseSha}`);
    const commonDirOutput = (await checkedGit(root, ["rev-parse", "--git-common-dir"])).trim();
    const commonDir = await realpath(resolve(root, commonDirOutput));
    assertRealPathContained(root, commonDir, `Repository ${root} Git metadata escaped its checkout`);
    if (mount.mode === "read") snapshots.push(await repositoryIntegritySnapshot(root, head));
  }
  if (!primaryFound) throw new Error("Primary workspace is outside the repository mount manifest");
  return snapshots;
}

async function repositoryIntegritySnapshot(root: string, head?: string): Promise<RepositoryIntegritySnapshot> {
  return {
    root,
    head: head ?? (await checkedGit(root, ["rev-parse", "HEAD"])).trim(),
    status: await checkedGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    refs: await checkedGit(root, ["show-ref", "--head"]),
    localConfig: await checkedGit(root, ["config", "--local", "--null", "--list"]),
  };
}

async function assertReadOnlyRepositoriesUnchanged(snapshots: RepositoryIntegritySnapshot[]): Promise<void> {
  for (const before of snapshots) {
    const after = await repositoryIntegritySnapshot(before.root);
    if (after.head !== before.head || after.status !== before.status || after.refs !== before.refs || after.localConfig !== before.localConfig) {
      throw new Error(`Read-only repository was modified: ${before.root}`);
    }
  }
}

async function checkedGit(root: string, args: string[]): Promise<string> {
  const result = await runSafeCommand({ executable: "git", args, cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed for ${root}: ${safeText(result.stderr)}`);
  return result.stdout;
}

async function applyInputPatch(path: string): Promise<void> {
  const controlRoot = await realpath(manifest.controlRoot);
  const canonical = await realpath(path);
  assertRealPathContained(controlRoot, canonical, "Input patch escaped the Code Task control root");
  const result = await runSafeCommand({
    executable: "git",
    args: ["apply", "--index", "--binary", "--", canonical],
    cwd: manifest.workspaceRoot,
  });
  await rm(canonical, { force: true });
  if (result.exitCode !== 0) throw new Error(`Input patch could not be applied: ${safeText(result.stderr)}`);
}

function assertRealPathContained(rootInput: string, targetInput: string, message: string): void {
  const root = resolve(rootInput);
  const target = resolve(targetInput);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(message);
}

async function receiveCredentials(): Promise<ReturnType<typeof CodeTaskWorkerCredentialsSchema.parse>> {
  const line = await new Promise<string>((resolveLine, reject) => {
    let buffered = "";
    let timeout: NodeJS.Timeout;
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      if (Buffer.byteLength(buffered, "utf8") > 64 * 1024) return finish(new Error("Code Task credentials exceeded 64 KiB"));
      const newline = buffered.indexOf("\n");
      if (newline >= 0) finish(undefined, buffered.slice(0, newline));
    };
    const onEnd = () => finish(new Error("Code Task credential channel closed before a JSON line was received"));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      // The runtime intentionally sends exactly one JSON line and keeps no
      // credential material in the initial environment. Close our end of the
      // pipe after consuming it so the one-shot channel cannot keep the worker
      // event loop alive after a terminal result has been written.
      process.stdin.destroy();
      if (error) reject(error); else resolveLine(value ?? "");
    };
    timeout = setTimeout(() => finish(new Error("Timed out waiting for one-shot Code Task credentials")), 10_000);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
  try {
    return CodeTaskWorkerCredentialsSchema.parse(JSON.parse(line));
  } catch {
    throw new Error("Code Task credential channel contained an invalid payload");
  }
}

async function assertOuterWorkerIsolation(): Promise<void> {
  if (manifest.isolation !== "bwrap") return;
  const [nullDevice, randomDevice, sharedMemory] = await Promise.all([
    lstat("/dev/null"),
    lstat("/dev/urandom"),
    lstat("/dev/shm"),
  ]);
  if (!nullDevice.isCharacterDevice() || !randomDevice.isCharacterDevice() || !sharedMemory.isDirectory()) {
    throw new Error("Code Task worker did not receive the required fresh device namespace");
  }
  for (const sentinel of ["/dev/qasey-host-device-sentinel", "/tmp/qasey-host-sentinel"]) {
    if (await exists(sentinel)) throw new Error(`Code Task worker can see forbidden host sentinel ${sentinel}`);
  }
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function isRuntimeGeneratedPath(path: string): boolean {
  return path === "node_modules" || path.startsWith("node_modules/")
    || path === ".pnpm-store" || path.startsWith(".pnpm-store/")
    || path === ".yarn/cache" || path.startsWith(".yarn/cache/");
}

function fixedCheckEnvironment(checkRoot: string): Record<string, string> {
  const inheritedKeys = [
    "PATH", "CI", "BASE_URL", "QASEY_E2E_BASE_URL", "QASEY_E2E_STORAGE_STATE_PATH", "PLAYWRIGHT_BROWSERS_PATH",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  ];
  const home = join(checkRoot, "home");
  const packageCacheRoot = manifest.packageStoreRoot;
  return {
    ...Object.fromEntries(inheritedKeys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: packageCacheRoot ? join(packageCacheRoot, "metadata-cache") : join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    ...(packageCacheRoot ? {
      COREPACK_HOME: join(packageCacheRoot, "corepack"),
      PNPM_CONFIG_STORE_DIR: packageCacheRoot,
    } : {}),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function safeText(value: string, max = 32_000): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/giu, "$1[REDACTED]")
    .replace(/\b((?:token|secret|password|cookie|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .slice(-max);
}
