import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySandboxLeaseStore } from "../../src/platform/workspace/sandbox-lease-store.ts";
import { SandboxPoolClient } from "../../src/platform/workspace/sandbox-client.ts";
import { SandboxRepositoryCloneSchema } from "../../src/platform/workspace/sandbox-protocol.ts";
import { QaseySandboxRuntime } from "../../src/sandbox/runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
});

describe("sandbox runtime protocol", () => {
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
});
