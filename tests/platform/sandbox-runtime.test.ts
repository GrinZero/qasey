import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySandboxLeaseStore } from "../../src/platform/workspace/sandbox-lease-store.ts";
import { SandboxPoolClient } from "../../src/platform/workspace/sandbox-client.ts";
import { SandboxRepositoryCloneSchema } from "../../src/platform/workspace/sandbox-protocol.ts";
import { QaseySandboxRuntime, sandboxRuntimeOptions } from "../../src/sandbox/runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
});

describe("sandbox runtime protocol", () => {
  it("does not require image provenance metadata in production", () => {
    expect(() => sandboxRuntimeOptions({ NODE_ENV: "production" })).not.toThrow();
  });

  it("rejects repository dot segments before resolving a clone destination", () => {
    expect(SandboxRepositoryCloneSchema.safeParse({ repository: "../private", destination: "repo" }).success).toBe(false);
    expect(SandboxRepositoryCloneSchema.safeParse({ repository: "acme/..", destination: "repo" }).success).toBe(false);
  });

  it("persists contained files and executes commands for an authenticated session", async () => {
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright");
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-sandbox-runtime-"));
    const runtime = new QaseySandboxRuntime({ dataRoot, port: 0, host: "127.0.0.1", maxSessions: 2, idleTtlMs: 60_000, isolation: "none", commandTimeoutMs: 10_000, workspaceRetentionMs: 7 * 24 * 60 * 60_000 });
    const server = await runtime.start();
    cleanups.push(async () => { await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
    const leases = new InMemorySandboxLeaseStore({ replicas: 1, maxSessionsPerReplica: 2, idleTtlMs: 60_000, encryptionKey: "test-key" });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 10_000,
      githubTokenForScope: async () => "ghs_test_read_only_token_12345678901234567890",
    });
    const scope = { applicationId: "qasey", tenantId: "tenant", sessionId: "session" };
    const filesystem = pool.filesystem(scope);
    await filesystem.init();
    await filesystem.writeFile("hello.txt", "persistent", { recursive: true });
    await expect(filesystem.readFile("hello.txt", { encoding: "utf8" })).resolves.toBe("persistent");
    await expect(filesystem.readFile("../../etc/passwd", { encoding: "utf8" })).rejects.toThrow();
    const sandbox = pool.sandbox(scope);
    await sandbox.start();
    await expect(sandbox.executeCommand?.("sh", ["-c", "printf command-ok"])).resolves.toMatchObject({ exitCode: 0, stdout: "command-ok" });
    await expect(sandbox.executeCommand?.("sh", ["-c", "test -n \"$GH_TOKEN\" && test -n \"$GIT_CONFIG_VALUE_0\""])).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.executeCommand?.("sh", ["-c", "printf %s \"$PLAYWRIGHT_BROWSERS_PATH\""])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/ms-playwright",
    });

    const session = await pool.session(scope);
    await expect(session.claim()).resolves.toMatchObject({
      desktop: { running: false, available: false },
      browser: { running: false },
    });
    await expect(session.desktopStart()).rejects.toThrow("Computer-use desktop is disabled or unavailable");
    const unauthorized = await fetch(`${session.endpoint}/v1/sessions/${encodeURIComponent(scope.sessionId)}/filesystem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qasey-session-token": "wrong-token-with-enough-characters-123", "x-qasey-lease-generation": String(session.lease.generation) },
      body: JSON.stringify({ operation: "exists", path: "hello.txt" }),
    });
    expect(unauthorized.status).toBe(401);
  });

  it("enforces one worker per session and cancels the complete worker process group", async () => {
    vi.stubEnv("CODEX_API_KEY", "model-key-visible-only-to-agent-profiles");
    vi.stubEnv("GITHUB_TOKEN", "github-token-must-not-reach-worker");
    vi.stubEnv("QASEY_DEV_AUTH_TOKEN", "control-plane-token-must-not-reach-worker");
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-code-task-runtime-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none", commandTimeoutMs: 10_000,
      workspaceRetentionMs: 60_000,
      codeTaskWorkerPath: resolve("tests/fixtures/code-task-hanging-worker.mjs"),
      codeTaskRepositoryPreparer: async (_repositoryRoot, _spec, taskRoot) => {
        const workspace = join(taskRoot, "repositories", "target");
        await mkdir(workspace, { recursive: true });
        return workspace;
      },
    });
    const server = await runtime.start();
    cleanups.push(async () => { await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
    const leases = new InMemorySandboxLeaseStore({ replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key" });
    await leases.init();
    const pool = new SandboxPoolClient(leases, { endpointTemplate: `http://127.0.0.1:${server.port}`, requestTimeoutMs: 10_000 });
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId: "code-task-session" });
    const context = "frozen context";
    const spec = {
      taskId: "task-1", attemptId: "attempt-1", kind: "author" as const,
      scope: { applicationId: "qasey", tenantId: "tenant", sessionId: "code-task-session" },
      contextRef: { id: "context", kind: "report" as const, name: "context.json", uri: "sandbox://context.json" },
      contextHash: createHash("sha256").update(context).digest("hex"),
      repositories: [{ owner: "MoeGolibrary", repository: "moego-e2e-autotest", destination: "target", mode: "write" as const, baseRef: "main", baseSha: "a".repeat(40) }],
      baseSha: "a".repeat(40), executionProfileId: "web-e2e-verifier" as const, allowedPaths: ["tests"], fixedChecks: [], deadlineMs: 60_000, traceContext: {},
    };

    await session.codeTaskStart(spec, context);
    await waitUntil(async () => (await session.codeTaskState(spec.taskId)).status === "running");
    await expect(session.codeTaskStart({ ...spec, taskId: "task-2", attemptId: "attempt-2" }, context)).rejects.toThrow(/already running/u);
    const pidResult = await session.filesystem<{ content: string } & { encoding: string }>({ operation: "readFile", path: "code-tasks/task-1/attempt-1/child.pid", encoding: "utf8" });
    const childPid = Number(pidResult.content);
    expect(processExists(childPid)).toBe(true);
    const credentialResult = await session.filesystem<{ content: string; encoding: string }>({ operation: "readFile", path: "code-tasks/task-1/attempt-1/credential-presence.json", encoding: "utf8" });
    expect(JSON.parse(credentialResult.content)).toEqual({ model: false, github: false, controlPlane: false });

    await expect(session.codeTaskCancel(spec.taskId, "test cancellation")).resolves.toMatchObject({ status: "cancelled" });
    await waitUntil(async () => !processExists(childPid));
    const events = await session.codeTaskEvents(spec.taskId);
    expect(events.events.map(event => event.type)).toEqual(expect.arrayContaining(["task.cancel_requested", "task.cancelled"]));
    expect(events.events.findIndex(event => event.type === "task.cancel_requested"))
      .toBeLessThan(events.events.findIndex(event => event.type === "task.cancelled"));
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sandbox state");
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
