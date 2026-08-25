import { createHash } from "node:crypto";
import { access, appendFile, copyFile, lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  CodeTaskResultSchema,
  type ArtifactRef,
  type CheckResult,
  type CodeTaskChange,
  type CodeTaskEvent,
  type CodeTaskResult,
  type CodeTaskState,
} from "../../packages/contracts/src/index.ts";
import {
  CodeTaskWorkerManifestSchema,
  NativeMastraCodingBackend,
  executionProfile,
  executionProfileHash,
} from "../../packages/code-task/src/index.ts";
import { runSafeCommand } from "../../packages/e2e/src/process.ts";
import { webE2EPlaywrightPlans, webE2ERepositoryFromSkill } from "../platform/code-task/e2e-repository-skill.ts";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("code-task-worker requires a manifest path");
const manifest = CodeTaskWorkerManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
await rm(manifestPath, { force: true });
const { spec } = manifest;
const canonicalWorkspaceRoot = await realpath(manifest.workspaceRoot);
const profile = executionProfile(spec.executionProfileId);
let cursor = 0;
const abortController = new AbortController();
process.once("SIGTERM", () => abortController.abort(new Error("Code task cancelled")));
process.once("SIGINT", () => abortController.abort(new Error("Code task cancelled")));

await emit("task.started", `Starting ${spec.executionProfileId}`);
const createdAt = new Date().toISOString();
await writeState({ taskId: spec.taskId, attemptId: spec.attemptId, status: "running", createdAt, updatedAt: createdAt });

try {
  verifyContextIntegrity(manifest.context, spec.contextHash);
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
  const result = CodeTaskResultSchema.parse({
    status: cancelled ? "cancelled" : "failed",
    summary: safeText(error instanceof Error ? error.message : String(error)),
    changedPaths: await changedPaths(manifest.workspaceRoot).catch(() => []),
    changes: [],
    checks: [],
    artifacts: [],
    provenance: provenance(),
  });
  await finish(result);
  if (!cancelled) process.exitCode = 1;
}

async function runAgent(): Promise<string> {
  const output = await new NativeMastraCodingBackend().run({
    taskId: spec.taskId,
    workspaceRoot: manifest.workspaceRoot,
    context: manifest.context,
    allowedPaths: spec.allowedPaths,
    profile,
    traceContext: spec.traceContext,
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
  const result = await runSafeCommand({
    executable: command.executable,
    args: command.args,
    cwd: manifest.workspaceRoot,
    timeoutMs: Math.min(spec.deadlineMs, 10 * 60_000),
  });
  const logPath = join(manifest.taskRoot, "artifacts", "repo-install.log");
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
    return { executable: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
  }
  if (await exists(join(manifest.workspaceRoot, "yarn.lock"))) {
    return { executable: "corepack", args: ["yarn", "install", "--immutable", "--mode=skip-builds"] };
  }
  if (await exists(join(manifest.workspaceRoot, "package-lock.json"))) {
    return { executable: "npm", args: ["ci", "--ignore-scripts"] };
  }
  return undefined;
}

async function runPlaywrightCheck(paths: string[]): Promise<CheckResult> {
  const artifactRoot = join(manifest.taskRoot, "artifacts", "playwright");
  await mkdir(artifactRoot, { recursive: true });
  const plans = playwrightPlans(paths);
  const artifacts: ArtifactRef[] = [];
  const summaries: string[] = [];
  let passed = true;
  let exitCode = 0;
  let durationMs = 0;
  for (const plan of plans) {
    abortController.signal.throwIfAborted();
    const planRoot = join(artifactRoot, plan.id);
    await mkdir(planRoot, { recursive: true });
    const result = await runSafeCommand({
      executable: "pnpm",
      args: [
        "exec", "playwright", "test", ...plan.testFiles,
        ...(plan.config ? [`--config=${plan.config}`] : []),
        ...(plan.playwrightProject ? [`--project=${plan.playwrightProject}`] : []),
        "--reporter=line,junit,html", "--output", join(planRoot, "test-results"),
      ],
      cwd: manifest.workspaceRoot,
      env: {
        ...fixedCheckEnvironment(),
        PLAYWRIGHT_HTML_OUTPUT_DIR: join(planRoot, "html-report"),
        PLAYWRIGHT_JUNIT_OUTPUT_NAME: join(planRoot, "results.xml"),
      },
      timeoutMs: Math.min(spec.deadlineMs, 15 * 60_000),
    });
    const logPath = join(planRoot, "playwright.log");
    await writeFile(logPath, safeText(`${result.stdout}\n${result.stderr}`, 2_000_000), { mode: 0o600 });
    artifacts.push({ id: `${spec.taskId}:playwright-${plan.id}-log`, kind: "log", name: `${plan.id}-playwright.log`, uri: sandboxUri(logPath), contentType: "text/plain" });
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

interface PlaywrightPlan {
  id: string;
  config?: string;
  playwrightProject?: string;
  testFiles: string[];
}

function playwrightPlans(paths: string[]): PlaywrightPlan[] {
  const target = spec.repositories[0];
  const configuredTarget = webE2ERepositoryFromSkill();
  if (target?.owner === configuredTarget.owner && target.repository === configuredTarget.repository) {
    return webE2EPlaywrightPlans(paths);
  }
  return [{ id: "default", testFiles: paths.filter(path => /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path)) }];
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
  const target = join(manifest.taskRoot, "artifacts", "changes.patch");
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
    const target = join(manifest.taskRoot, "artifacts", "files", `${String(changes.length).padStart(4, "0")}.bin`);
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

async function writeState(state: CodeTaskState): Promise<void> {
  await mkdir(dirname(manifest.statePath), { recursive: true });
  await writeFile(manifest.statePath, JSON.stringify(state), { mode: 0o600 });
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
    imageDigest: process.env.QASEY_IMAGE_DIGEST?.trim() || "unknown-internal-image",
    profileHash: executionProfileHash(profile),
    agentBackend: "native-mastra" as const,
    mastraVersion: process.env.QASEY_MASTRA_VERSION?.trim() || "unverified",
    model: process.env.QASEY_CODE_AGENT_MODEL?.trim() || "gpt-5.6-sol",
  };
}

function sandboxUri(path: string): string {
  const rel = relative(manifest.repositoryRoot, path);
  if (rel.startsWith("..")) throw new Error("Artifact escaped sandbox repository root");
  return `sandbox://${rel.split(sep).join("/")}`;
}

function resolveContained(rootInput: string, path: string): string {
  const root = resolve(rootInput);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`Path escaped task workspace: ${path}`);
  return target;
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function isRuntimeGeneratedPath(path: string): boolean {
  return path === "node_modules" || path.startsWith("node_modules/")
    || path === ".pnpm-store" || path.startsWith(".pnpm-store/")
    || path === ".yarn/cache" || path.startsWith(".yarn/cache/");
}

function fixedCheckEnvironment(): Record<string, string> {
  const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CI", "BASE_URL", "QASEY_E2E_BASE_URL", "QASEY_E2E_STORAGE_STATE_PATH"];
  return Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
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
