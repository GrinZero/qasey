import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandResult, ExecuteCommandOptions } from "@mastra/core/workspace";
import type { Browser } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySandboxLeaseStore } from "../../src/platform/workspace/sandbox-lease-store.ts";
import { SandboxPoolClient } from "../../src/platform/workspace/sandbox-client.ts";
import { signSandboxControlToken } from "../../src/platform/workspace/sandbox-control-token.ts";
import { SandboxRepositoryCloneSchema } from "../../src/platform/workspace/sandbox-protocol.ts";
import {
  evaluateSandboxBrowserRequestPolicy,
  QaseySandboxRuntime,
  SANDBOX_READINESS_PROBE,
  sandboxRuntimeOptions,
} from "../../src/sandbox/runtime.ts";

const TEST_CONTROL_KEY = "sandbox-control-test-key-000000000000000000000000";
const TEST_EGRESS_PROXY_URL = "http://egress-proxy.example:3128";
const TEST_BROWSER_ALLOWED_ORIGINS = "https://app.example.com,http://localhost:3000";
const TEST_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const PRODUCTION_NETWORK_ENV = {
  QASEY_SANDBOX_EGRESS_PROXY_URL: TEST_EGRESS_PROXY_URL,
  QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS: TEST_BROWSER_ALLOWED_ORIGINS,
  QASEY_IMAGE_DIGEST: TEST_IMAGE_DIGEST,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
});

describe("sandbox runtime protocol", () => {
  it("gates readiness on the fresh device contract", () => {
    expect(SANDBOX_READINESS_PROBE).toContain("test -c /dev/null");
    expect(SANDBOX_READINESS_PROBE).toContain("test -c /dev/urandom");
    expect(SANDBOX_READINESS_PROBE).toContain("test -d /dev/shm");
  });

  it("single-flights stale readiness checks and recovers after a cached failure", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-sandbox-readiness-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const internals = runtime as unknown as {
      readinessCheckedAt: number;
      runReadinessCheck(): Promise<void>;
    };
    const readinessCheck = vi.spyOn(internals, "runReadinessCheck").mockResolvedValue(undefined);
    const server = await runtime.start();
    cleanups.push(async () => { await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
    const endpoint = `http://127.0.0.1:${server.port}/readyz`;

    expect((await fetch(endpoint)).status).toBe(200);
    expect(readinessCheck).toHaveBeenCalledTimes(1);
    internals.readinessCheckedAt = 0;
    readinessCheck.mockRejectedValueOnce(new Error("synthetic bwrap degradation"));
    const degraded = await Promise.all([fetch(endpoint), fetch(endpoint)]);
    expect(degraded.map(response => response.status)).toEqual([503, 503]);
    expect(readinessCheck).toHaveBeenCalledTimes(2);
    expect((await fetch(endpoint)).status).toBe(503);
    expect(readinessCheck).toHaveBeenCalledTimes(2);

    internals.readinessCheckedAt = 0;
    readinessCheck.mockResolvedValueOnce(undefined);
    expect((await fetch(endpoint)).status).toBe(200);
    expect(readinessCheck).toHaveBeenCalledTimes(3);
  });

  it("does not let an old completion callback clear a newer Code Task guard", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-code-task-completion-race-"));
    cleanups.push(async () => { await rm(dataRoot, { recursive: true, force: true }); });
    const statePath = join(dataRoot, "state.json");
    const now = new Date().toISOString();
    await writeFile(statePath, JSON.stringify({
      taskId: "old-task",
      attemptId: "old-attempt",
      status: "failed",
      createdAt: now,
      updatedAt: now,
      error: "synthetic terminal state",
    }));
    const oldHeartbeat = setInterval(() => undefined, 60_000);
    const oldDeadline = setTimeout(() => undefined, 60_000);
    const newHeartbeat = setInterval(() => undefined, 60_000);
    const newDeadline = setTimeout(() => undefined, 60_000);
    oldHeartbeat.unref();
    oldDeadline.unref();
    newHeartbeat.unref();
    newDeadline.unref();
    cleanups.push(async () => {
      clearInterval(oldHeartbeat);
      clearTimeout(oldDeadline);
      clearInterval(newHeartbeat);
      clearTimeout(newDeadline);
    });
    const oldActive = {
      taskId: "old-task",
      attemptId: "old-attempt",
      process: { exitCode: 0 },
      sandbox: { _destroy: vi.fn().mockResolvedValue(undefined) },
      taskRoot: dataRoot,
      statePath,
      eventsPath: join(dataRoot, "events.ndjson"),
      heartbeat: oldHeartbeat,
      hardDeadline: oldDeadline,
    };
    const newerActive = {
      ...oldActive,
      taskId: "new-task",
      attemptId: "new-attempt",
      process: { exitCode: undefined },
      heartbeat: newHeartbeat,
      hardDeadline: newDeadline,
    };
    const session: { activeCodeTask: unknown; lastActivityAt: number } = { activeCodeTask: oldActive, lastActivityAt: 0 };
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const finish = (runtime as unknown as {
      finishCodeTaskProcess(targetSession: unknown, active: unknown, error?: Error): Promise<void>;
    }).finishCodeTaskProcess.bind(runtime);

    const completion = finish(session, oldActive);
    session.activeCodeTask = newerActive;
    await completion;

    expect(session.activeCodeTask).toBe(newerActive);
    expect(oldActive.sandbox._destroy).toHaveBeenCalledOnce();
  });

  it("releases the active guard and sandbox when terminal state persistence fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-code-task-finalize-failure-"));
    const statePath = join(dataRoot, "state-as-directory");
    await mkdir(statePath);
    const heartbeat = setInterval(() => undefined, 60_000);
    const hardDeadline = setTimeout(() => undefined, 60_000);
    heartbeat.unref();
    hardDeadline.unref();
    cleanups.push(async () => {
      clearInterval(heartbeat);
      clearTimeout(hardDeadline);
      await rm(dataRoot, { recursive: true, force: true });
    });
    const active = {
      taskId: "broken-state-task",
      attemptId: "broken-state-attempt",
      process: { exitCode: 1 },
      sandbox: { _destroy: vi.fn().mockResolvedValue(undefined) },
      taskRoot: dataRoot,
      statePath,
      eventsPath: join(dataRoot, "events.ndjson"),
      heartbeat,
      hardDeadline,
    };
    const session: { activeCodeTask?: unknown; lastActivityAt: number } = { activeCodeTask: active, lastActivityAt: 0 };
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const finish = (runtime as unknown as {
      finishCodeTaskProcess(targetSession: unknown, targetActive: unknown, error?: Error): Promise<void>;
    }).finishCodeTaskProcess.bind(runtime);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(finish(session, active, new Error("synthetic worker failure"))).resolves.toBeUndefined();

    expect(session.activeCodeTask).toBeUndefined();
    expect(active.sandbox._destroy).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("sandbox.code_task.terminal_state_write_failed"));
  });

  it("does not let stop overtake Code Task sandbox finalization", async () => {
    let markDestroyEntered!: () => void;
    let releaseDestroy!: () => void;
    const destroyEntered = new Promise<void>(resolveWait => { markDestroyEntered = resolveWait; });
    const destroyReleased = new Promise<void>(resolveWait => { releaseDestroy = resolveWait; });
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-code-task-finalization-drain-"));
    const statePath = join(dataRoot, "state.json");
    const now = new Date().toISOString();
    await writeFile(statePath, JSON.stringify({
      taskId: "finalization-drain-task",
      attemptId: "finalization-drain-attempt",
      status: "failed",
      createdAt: now,
      updatedAt: now,
      error: "synthetic terminal state",
    }));
    const heartbeat = setInterval(() => undefined, 60_000);
    const hardDeadline = setTimeout(() => undefined, 60_000);
    heartbeat.unref();
    hardDeadline.unref();
    cleanups.push(async () => {
      releaseDestroy();
      clearInterval(heartbeat);
      clearTimeout(hardDeadline);
      await rm(dataRoot, { recursive: true, force: true });
    });
    const taskSandbox = {
      _destroy: vi.fn(async () => {
        markDestroyEntered();
        await destroyReleased;
      }),
    };
    const active = {
      taskId: "finalization-drain-task",
      attemptId: "finalization-drain-attempt",
      process: { exitCode: 0 },
      sandbox: taskSandbox,
      taskRoot: dataRoot,
      statePath,
      eventsPath: join(dataRoot, "events.ndjson"),
      heartbeat,
      hardDeadline,
      finalization: undefined as Promise<void> | undefined,
    };
    const session = {
      sessionId: "finalization-drain-session",
      inFlightRequests: new Set(),
      activeCodeTask: active,
      sandbox: { _destroy: vi.fn().mockResolvedValue(undefined) },
      filesystem: { _destroy: vi.fn().mockResolvedValue(undefined) },
      lastActivityAt: 0,
    };
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const internals = runtime as unknown as {
      finishCodeTaskProcess(targetSession: unknown, targetActive: unknown, error?: Error): Promise<void>;
      closeSession(targetSession: unknown): Promise<void>;
    };
    const finalization = internals.finishCodeTaskProcess(session, active);
    active.finalization = finalization;
    await destroyEntered;
    let stopFinished = false;
    const stopping = internals.closeSession(session).then(() => { stopFinished = true; });
    await new Promise(resolveWait => setTimeout(resolveWait, 25));

    expect(stopFinished).toBe(false);
    expect(session.activeCodeTask).toBe(active);
    releaseDestroy();
    await finalization;
    await stopping;
    expect(stopFinished).toBe(true);
    expect(session.activeCodeTask).toBeUndefined();
  });

  it("aborts a reserved Code Task when the owning session closes during preparation", async () => {
    let markPreparationEntered!: () => void;
    let releasePreparation!: () => void;
    const preparationEntered = new Promise<void>(resolveWait => { markPreparationEntered = resolveWait; });
    const preparationReleased = new Promise<void>(resolveWait => { releasePreparation = resolveWait; });
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-code-task-close-race-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
      codeTaskWorkerPath: resolve("tests/fixtures/code-task-hanging-worker.mjs"),
      codeTaskRepositoryPreparer: async (_repositoryRoot, _spec, taskRoot) => {
        markPreparationEntered();
        await preparationReleased;
        const workspace = join(taskRoot, "repositories", "target");
        await mkdir(workspace, { recursive: true });
        return workspace;
      },
    });
    const server = await runtime.start();
    cleanups.push(async () => {
      releasePreparation();
      await server.close();
      await rm(dataRoot, { recursive: true, force: true });
    });
    const leases = new InMemorySandboxLeaseStore({
      replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key",
    });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
    });
    const sessionId = "code-task-close-race-session";
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId });
    const context = "frozen context";
    const spec = {
      taskId: "close-race-task", attemptId: "close-race-attempt", kind: "author" as const,
      scope: { applicationId: "qasey", tenantId: "tenant", sessionId },
      contextRef: { id: "context", kind: "report" as const, name: "context.json", uri: "sandbox://context.json" },
      contextHash: createHash("sha256").update(context).digest("hex"),
      repositories: [{
        owner: "example-org", repository: "web-e2e", destination: "target", mode: "write" as const,
        baseRef: "main", baseSha: "a".repeat(40),
      }],
      baseSha: "a".repeat(40), executionProfileId: "web-e2e-author" as const,
      allowedPaths: ["tests"], fixedChecks: [], deadlineMs: 60_000, traceContext: {},
    };

    const starting = session.codeTaskStart(spec, context);
    const startingRejection = expect(starting).rejects.toThrow(/session is closing/u);
    await preparationEntered;
    const internals = runtime as unknown as { sessions: Map<string, { closing?: boolean }> };
    const stopping = session.stop();
    await vi.waitFor(() => expect([...internals.sessions.values()][0]?.closing).toBe(true));
    releasePreparation();
    await stopping;

    await startingRejection;
    const attemptRoot = join(dataRoot, "code-tasks", session.lease.workspaceId, spec.taskId, spec.attemptId);
    await expect(access(join(attemptRoot, "artifacts", "child.pid"))).rejects.toThrow();
    await expect(access(attemptRoot)).rejects.toThrow();
    expect(internals.sessions.size).toBe(0);
  });

  it("serializes concurrent browser starts before launching a browser", async () => {
    let markLaunchEntered!: () => void;
    let releaseLaunch!: () => void;
    const launchEntered = new Promise<void>(resolveWait => { markLaunchEntered = resolveWait; });
    const launchReleased = new Promise<void>(resolveWait => { releaseLaunch = resolveWait; });
    const fake = fakeHeadlessBrowser();
    const launcher = vi.fn(async () => {
      markLaunchEntered();
      await launchReleased;
      return fake.browser;
    });
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-browser-start-race-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
      headlessBrowserLauncher: launcher,
    });
    const server = await runtime.start();
    cleanups.push(async () => {
      releaseLaunch();
      await server.close();
      await rm(dataRoot, { recursive: true, force: true });
    });
    const leases = new InMemorySandboxLeaseStore({
      replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key",
    });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
    });
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId: "browser-start-race" });

    const firstStart = session.browserStart();
    await launchEntered;
    const concurrentStart = session.browserStart();
    const concurrentError = await concurrentStart.then(() => undefined, error => error as unknown);
    releaseLaunch();
    const results = await Promise.allSettled([firstStart, concurrentStart]);

    expect(results[0]).toMatchObject({ status: "fulfilled", value: { browser: { running: true } } });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(concurrentError).toBeInstanceOf(Error);
    expect(String(concurrentError)).toMatch(/already starting or updating its browser/u);
    expect(launcher).toHaveBeenCalledOnce();
    const browserWorkspace = join(dataRoot, "browser", session.lease.workspaceId);
    expect((await readdir(browserWorkspace)).some(entry => entry.startsWith("run-"))).toBe(true);
    await session.stop();
    expect((await readdir(browserWorkspace)).filter(entry => entry.startsWith("run-"))).toEqual([]);
  });

  it("destroys a browser launched after its owning session begins closing", async () => {
    let markLaunchEntered!: () => void;
    let releaseLaunch!: () => void;
    const launchEntered = new Promise<void>(resolveWait => { markLaunchEntered = resolveWait; });
    const launchReleased = new Promise<void>(resolveWait => { releaseLaunch = resolveWait; });
    const fake = fakeHeadlessBrowser();
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-browser-close-race-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
      headlessBrowserLauncher: async () => {
        markLaunchEntered();
        await launchReleased;
        return fake.browser;
      },
    });
    const server = await runtime.start();
    cleanups.push(async () => {
      releaseLaunch();
      await server.close();
      await rm(dataRoot, { recursive: true, force: true });
    });
    const leases = new InMemorySandboxLeaseStore({
      replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key",
    });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
    });
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId: "browser-close-race" });

    const starting = session.browserStart();
    const startingRejection = expect(starting).rejects.toThrow(/session is closing/u);
    await launchEntered;
    const internals = runtime as unknown as { sessions: Map<string, { closing?: boolean }> };
    const stopping = session.stop();
    await vi.waitFor(() => expect([...internals.sessions.values()][0]?.closing).toBe(true));
    releaseLaunch();
    await stopping;

    await startingRejection;
    expect(fake.browserMock.newContext).not.toHaveBeenCalled();
    expect(fake.browserMock.close).toHaveBeenCalledOnce();
    expect(internals.sessions.size).toBe(0);
  });

  it("uses a safe production isolation default and requires a dedicated control key", () => {
    expect(sandboxRuntimeOptions({ NODE_ENV: "production", QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY, ...PRODUCTION_NETWORK_ENV }))
      .toMatchObject({ isolation: "bwrap", controlKey: TEST_CONTROL_KEY, maxSessions: 1, imageDigest: TEST_IMAGE_DIGEST });
    expect(() => sandboxRuntimeOptions({ NODE_ENV: "production" })).toThrow(/control key/u);
    expect(() => sandboxRuntimeOptions({ NODE_ENV: "production", QASEY_SANDBOX_CONTROL_KEY: "too-short", ...PRODUCTION_NETWORK_ENV })).toThrow(/32 bytes/u);
    expect(() => sandboxRuntimeOptions({
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_ISOLATION: "none",
      ...PRODUCTION_NETWORK_ENV,
    })).toThrow(/production.*none/iu);
    expect(() => sandboxRuntimeOptions({
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_DESKTOP_ENABLED: "true",
      ...PRODUCTION_NETWORK_ENV,
    })).toThrow(/dedicated per-session VM or container/iu);
  });

  it("requires canonical production egress proxy and browser origin configuration", () => {
    expect(() => sandboxRuntimeOptions({
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS: TEST_BROWSER_ALLOWED_ORIGINS,
    })).toThrow(/QASEY_SANDBOX_EGRESS_PROXY_URL.*required/u);
    expect(() => sandboxRuntimeOptions({
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_EGRESS_PROXY_URL: TEST_EGRESS_PROXY_URL,
    })).toThrow(/QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS.*required/u);

    for (const proxyUrl of [
      "ftp://egress-proxy.example:2121",
      "http://proxy-user:proxy-password@egress-proxy.example.com:3128",
      "https://egress-proxy.example:3128/tunnel",
      "https://egress-proxy.example:3128/.",
      "https://egress-proxy.example:3128?",
      "not-a-url",
    ]) {
      expect(() => sandboxRuntimeOptions({
        NODE_ENV: "production",
        QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
        QASEY_SANDBOX_EGRESS_PROXY_URL: proxyUrl,
        QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS: TEST_BROWSER_ALLOWED_ORIGINS,
      })).toThrow(/QASEY_SANDBOX_EGRESS_PROXY_URL/u);
    }

    for (const origins of [
      "ftp://app.example.com",
      "https://user:password@app.example.com",
      "https://app.example.com/admin",
      "https://app.example.com/%2e",
      "https://app.example.com?tenant=example",
      "https://app.example.com?",
      "https://app.example.com#fragment",
      "https://app.example.com#",
      "https://app.example.com,,https://cdn.example.com",
      "not-an-origin",
    ]) {
      expect(() => sandboxRuntimeOptions({
        NODE_ENV: "production",
        QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
        QASEY_SANDBOX_EGRESS_PROXY_URL: TEST_EGRESS_PROXY_URL,
        QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS: origins,
      })).toThrow(/QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS/u);
    }

    expect(sandboxRuntimeOptions({
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_EGRESS_PROXY_URL: "HTTPS://EGRESS-PROXY.EXAMPLE:443/",
      QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS: "HTTPS://APP.EXAMPLE.COM:443/,http://localhost:3000,http://localhost:3000",
      QASEY_IMAGE_DIGEST: TEST_IMAGE_DIGEST,
    })).toMatchObject({
      egressProxyUrl: "https://egress-proxy.example",
      browserAllowedOrigins: ["https://app.example.com", "http://localhost:3000"],
    });
  });

  it("requires an immutable execution image digest in production", () => {
    expect(() => sandboxRuntimeOptions({
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_EGRESS_PROXY_URL: TEST_EGRESS_PROXY_URL,
      QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS: TEST_BROWSER_ALLOWED_ORIGINS,
    })).toThrow(/QASEY_IMAGE_DIGEST.*required/u);
    for (const digest of ["latest", "sha256:test", `sha256:${"A".repeat(64)}`]) {
      expect(() => sandboxRuntimeOptions({
        NODE_ENV: "production",
        QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
        QASEY_SANDBOX_EGRESS_PROXY_URL: TEST_EGRESS_PROXY_URL,
        QASEY_SANDBOX_BROWSER_ALLOWED_ORIGINS: TEST_BROWSER_ALLOWED_ORIGINS,
        QASEY_IMAGE_DIGEST: digest,
      })).toThrow(/immutable sha256 OCI image digest/u);
    }
  });

  it("uses only explicit portable sandbox isolation modes", () => {
    expect(sandboxRuntimeOptions({ NODE_ENV: "test", QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY, QASEY_SANDBOX_ISOLATION: "none" }))
      .toMatchObject({ isolation: "none", browserAllowedOrigins: [] });
    expect(sandboxRuntimeOptions({ NODE_ENV: "test", QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY, QASEY_SANDBOX_ISOLATION: "bwrap" }))
      .toMatchObject({ isolation: "bwrap" });
    expect(() => sandboxRuntimeOptions({ QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY, QASEY_SANDBOX_ISOLATION: "pod" })).toThrow(/none or bwrap/u);
  });

  it("rejects multi-session production Sandbox processes until per-session cgroups exist", () => {
    expect(() => sandboxRuntimeOptions({
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_MAX_SESSIONS: "2",
      ...PRODUCTION_NETWORK_ENV,
    })).toThrow(/QASEY_SANDBOX_MAX_SESSIONS.*exactly 1/iu);
    expect(sandboxRuntimeOptions({
      NODE_ENV: "test",
      QASEY_SANDBOX_CONTROL_KEY: TEST_CONTROL_KEY,
      QASEY_SANDBOX_MAX_SESSIONS: "2",
    })).toMatchObject({ maxSessions: 2 });
  });

  it("applies exact-origin policy to navigations, redirects, and subresources", () => {
    const allowedOrigins = ["https://app.example.com", "http://localhost:3000"];
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "https://app.example.com/dashboard",
      resourceType: "document",
      isNavigationRequest: true,
    }, allowedOrigins)).toMatchObject({ allowed: true, reason: "allowed-origin" });
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "https://evil.example/redirect-target",
      resourceType: "document",
      isNavigationRequest: true,
      redirectedFromUrl: "https://app.example.com/start",
    }, allowedOrigins)).toMatchObject({ allowed: false, reason: "origin-not-allowed" });
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "https://cdn.example.com/application.js",
      resourceType: "script",
      isNavigationRequest: false,
    }, allowedOrigins)).toMatchObject({ allowed: false, reason: "origin-not-allowed" });
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "https://app.example.com:443/image.png",
      resourceType: "image",
      isNavigationRequest: false,
    }, allowedOrigins)).toMatchObject({ allowed: true });
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "wss://app.example.com/events",
      resourceType: "websocket",
      isNavigationRequest: false,
    }, allowedOrigins)).toMatchObject({ allowed: true, origin: "https://app.example.com" });
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "wss://events.example.com/socket",
      resourceType: "websocket",
      isNavigationRequest: false,
    }, allowedOrigins)).toMatchObject({ allowed: false, reason: "origin-not-allowed" });
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "https://user:password@app.example.com/private",
      resourceType: "document",
      isNavigationRequest: true,
    }, allowedOrigins)).toMatchObject({ allowed: false, reason: "url-credentials-not-allowed" });

    for (const url of ["about:blank", "about:srcdoc", "data:text/plain,internal"]) {
      expect(evaluateSandboxBrowserRequestPolicy({ url, resourceType: "document", isNavigationRequest: true }, allowedOrigins))
        .toMatchObject({ allowed: true, reason: "browser-internal" });
    }
    expect(evaluateSandboxBrowserRequestPolicy({
      url: "blob:https://app.example.com/018f632f-2e56-7c00-a4f4-7e55bbab37a1",
      resourceType: "document",
      isNavigationRequest: true,
    }, allowedOrigins)).toMatchObject({ allowed: true, reason: "browser-internal" });
    for (const url of [
      "blob:https://evil.example/018f632f-2e56-7c00-a4f4-7e55bbab37a1",
      "file:///etc/passwd",
      "javascript:fetch('https://evil.example')",
      "about:config",
    ]) {
      expect(evaluateSandboxBrowserRequestPolicy({ url, resourceType: "document", isNavigationRequest: true }, allowedOrigins))
        .toMatchObject({ allowed: false });
    }
  });

  it("rejects repository dot segments before resolving a clone destination", () => {
    expect(SandboxRepositoryCloneSchema.safeParse({ repository: "../private", destination: "repo" }).success).toBe(false);
    expect(SandboxRepositoryCloneSchema.safeParse({ repository: "acme/..", destination: "repo" }).success).toBe(false);
  });

  it("persists contained files and executes commands for an authenticated session", async () => {
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright");
    vi.stubEnv("OPENAI_API_KEY", "public-test-placeholder");
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-sandbox-runtime-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 2, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 7 * 24 * 60 * 60_000, controlKey: TEST_CONTROL_KEY,
      egressProxyUrl: TEST_EGRESS_PROXY_URL,
      browserAllowedOrigins: ["https://app.example.com"],
    });
    const server = await runtime.start();
    cleanups.push(async () => { await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
    const leases = new InMemorySandboxLeaseStore({ replicas: 1, maxSessionsPerReplica: 2, idleTtlMs: 60_000, encryptionKey: "test-key" });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      replicas: 1,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
      githubTokenForScope: async () => "synthetic-installation-token-0000000000",
    });
    await expect(pool.healthCheck()).resolves.toBeUndefined();
    await expect(pool.codeAgentHealthCheck()).resolves.toBeUndefined();
    expect(() => pool.assertTestEnvironmentAddress("http://127.0.0.1:4111")).not.toThrow();
    await expect(pool.capacity()).resolves.toEqual({
      replicas: 1,
      active: 0,
      maximum: 2,
      available: 2,
      unavailableReplicas: 0,
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
    await expect(sandbox.executeCommand?.("sh", ["-c", "test -z \"${GH_TOKEN:-}\" && test -z \"${GITHUB_TOKEN:-}\" && test -z \"${GIT_CONFIG_COUNT:-}\" && test -z \"${GIT_CONFIG_VALUE_0:-}\" && test -z \"${QASEY_GH_BROKER_URL:-}\" && test -z \"${QASEY_GH_BROKER_TOKEN:-}\""])).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.executeCommand?.("sh", ["-c", "printf %s \"$PLAYWRIGHT_BROWSERS_PATH\""])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/ms-playwright",
    });
    await expect(sandbox.executeCommand?.("sh", ["-c", "printf '%s|%s|%s|%s|%s|%s' \"$HTTP_PROXY\" \"$HTTPS_PROXY\" \"$ALL_PROXY\" \"$NO_PROXY\" \"${http_proxy:-}\" \"${no_proxy:-}\""], {
      env: {
        HTTP_PROXY: "http://override.invalid:8080",
        NO_PROXY: "*",
        http_proxy: "http://lowercase-override.invalid:8080",
        no_proxy: "*",
      },
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: `${TEST_EGRESS_PROXY_URL}|${TEST_EGRESS_PROXY_URL}|${TEST_EGRESS_PROXY_URL}|127.0.0.1,localhost,::1||`,
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

  it("rejects a loopback test URL for a remotely-networked Sandbox", async () => {
    const leases = new InMemorySandboxLeaseStore({ replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key" });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: "http://sandbox-0:4120",
      replicas: 1,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
    });
    expect(() => pool.assertTestEnvironmentAddress("http://localhost:4111")).toThrow(/loopback-only/u);
    expect(() => pool.assertTestEnvironmentAddress("http://qasey:4111")).not.toThrow();
  });

  it("aborts and drains an execute request before stop destroys its sandbox", async () => {
    let markExecuteEntered!: () => void;
    let releaseExecute!: () => void;
    let markAbortObserved!: () => void;
    const executeEntered = new Promise<void>(resolveWait => { markExecuteEntered = resolveWait; });
    const executeReleased = new Promise<void>(resolveWait => { releaseExecute = resolveWait; });
    const abortObserved = new Promise<void>(resolveWait => { markAbortObserved = resolveWait; });
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-execute-stop-race-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const server = await runtime.start();
    cleanups.push(async () => {
      releaseExecute();
      await server.close();
      await rm(dataRoot, { recursive: true, force: true });
    });
    const leases = new InMemorySandboxLeaseStore({
      replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key",
    });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      replicas: 1,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
    });
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId: "execute-stop-race" });
    await session.claim();
    const internals = runtime as unknown as {
      sessions: Map<string, {
        sandbox: {
          executeCommand?: (command: string, args?: string[], options?: ExecuteCommandOptions) => Promise<CommandResult>;
        };
      }>;
    };
    const active = [...internals.sessions.values()][0];
    if (!active) throw new Error("Expected an active sandbox session");
    let spawned = false;
    active.sandbox.executeCommand = async (_command, _args, options) => {
      const signal = options?.abortSignal;
      if (!signal) throw new Error("Expected execute request abort signal");
      if (signal.aborted) markAbortObserved();
      else signal.addEventListener("abort", markAbortObserved, { once: true });
      markExecuteEntered();
      await executeReleased;
      signal.throwIfAborted();
      spawned = true;
      return { success: true, exitCode: 0, stdout: "late spawn", stderr: "", executionTimeMs: 0 };
    };

    const executing = session.execute({ command: "sh", args: ["-c", "printf late-spawn"] });
    const executionRejection = expect(executing).rejects.toThrow(/session is closing/u);
    await executeEntered;
    const stopping = session.stop();
    await abortObserved;
    releaseExecute();

    await executionRejection;
    await expect(stopping).resolves.toBeUndefined();
    expect(spawned).toBe(false);
    expect(internals.sessions.size).toBe(0);
  });

  it("aborts and drains active requests during runtime shutdown", async () => {
    let markExecuteEntered!: () => void;
    let releaseExecute!: () => void;
    let markAbortObserved!: () => void;
    const executeEntered = new Promise<void>(resolveWait => { markExecuteEntered = resolveWait; });
    const executeReleased = new Promise<void>(resolveWait => { releaseExecute = resolveWait; });
    const abortObserved = new Promise<void>(resolveWait => { markAbortObserved = resolveWait; });
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-runtime-close-race-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
      shutdownTimeoutMs: 2_000,
    });
    const server = await runtime.start();
    cleanups.push(async () => {
      releaseExecute();
      await server.close();
      await rm(dataRoot, { recursive: true, force: true });
    });
    const leases = new InMemorySandboxLeaseStore({
      replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key",
    });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      replicas: 1,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
    });
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId: "runtime-close-race" });
    await session.claim();
    const internals = runtime as unknown as {
      sessions: Map<string, {
        sandbox: {
          executeCommand?: (command: string, args?: string[], options?: ExecuteCommandOptions) => Promise<CommandResult>;
        };
      }>;
    };
    const active = [...internals.sessions.values()][0];
    if (!active) throw new Error("Expected an active sandbox session");
    let spawned = false;
    active.sandbox.executeCommand = async (_command, _args, options) => {
      const signal = options?.abortSignal;
      if (!signal) throw new Error("Expected execute request abort signal");
      if (signal.aborted) markAbortObserved();
      else signal.addEventListener("abort", markAbortObserved, { once: true });
      markExecuteEntered();
      await executeReleased;
      signal.throwIfAborted();
      spawned = true;
      return { success: true, exitCode: 0, stdout: "late spawn", stderr: "", executionTimeMs: 0 };
    };

    const executing = session.execute({ command: "sh", args: ["-c", "printf late-spawn"] });
    const executionRejection = expect(executing).rejects.toThrow(/session is closing/u);
    await executeEntered;
    const shuttingDown = server.close();
    await abortObserved;
    releaseExecute();

    await executionRejection;
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(spawned).toBe(false);
    expect(internals.sessions.size).toBe(0);
  });

  it("serializes session claims so concurrent requests cannot exceed replica capacity", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-sandbox-claim-race-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const server = await runtime.start();
    cleanups.push(async () => { await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
    const internals = runtime as unknown as {
      claim(input: object): Promise<unknown>;
      sessions: Map<string, unknown>;
    };
    const claims = [
      { sessionId: "claim-race-a", workspaceId: "a".repeat(64), generation: 1, token: "a".repeat(32) },
      { sessionId: "claim-race-b", workspaceId: "b".repeat(64), generation: 1, token: "b".repeat(32) },
    ];

    const results = await Promise.allSettled(claims.map(claim => internals.claim(claim)));
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = results.find(result => result.status === "rejected");
    expect(rejection?.status === "rejected" ? String(rejection.reason) : "").toMatch(/at capacity/u);
    expect(internals.sessions.size).toBe(1);
  });

  it("linearizes stop after an in-progress idempotent claim state read", async () => {
    let markTitleReadEntered!: () => void;
    let releaseTitleRead!: () => void;
    const titleReadEntered = new Promise<void>(resolveWait => { markTitleReadEntered = resolveWait; });
    const titleReadReleased = new Promise<void>(resolveWait => { releaseTitleRead = resolveWait; });
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-claim-stop-linearization-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const server = await runtime.start();
    cleanups.push(async () => {
      releaseTitleRead();
      await server.close();
      await rm(dataRoot, { recursive: true, force: true });
    });
    const leases = new InMemorySandboxLeaseStore({
      replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key",
    });
    await leases.init();
    const pool = new SandboxPoolClient(leases, {
      endpointTemplate: `http://127.0.0.1:${server.port}`,
      replicas: 1,
      requestTimeoutMs: 10_000,
      controlKey: TEST_CONTROL_KEY,
    });
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId: "claim-stop-linearization" });
    await session.claim();
    const fake = fakeHeadlessBrowser();
    fake.page.title.mockImplementation(async () => {
      markTitleReadEntered();
      await titleReadReleased;
      return "linearized";
    });
    const browserRoot = join(dataRoot, "browser", session.lease.workspaceId);
    const runRoot = join(browserRoot, "run-linearization-test");
    await mkdir(runRoot, { recursive: true });
    const browserSandbox = { _destroy: vi.fn().mockResolvedValue(undefined) };
    const internals = runtime as unknown as {
      claim(input: object): Promise<{ browser: { running: boolean; title?: string } }>;
      closeSession(target: unknown): Promise<void>;
      sessions: Map<string, { browser?: unknown }>;
    };
    const active = [...internals.sessions.values()][0];
    if (!active) throw new Error("Expected an active sandbox session");
    active.browser = {
      browser: fake.browser,
      context: fake.context,
      page: fake.page,
      sandbox: browserSandbox,
      root: browserRoot,
      runRoot,
      storageStatePath: join(browserRoot, "storage-state.json"),
    };
    const closeSpy = vi.spyOn(internals, "closeSession");
    const idempotentClaim = internals.claim({
      sessionId: session.lease.sessionId,
      workspaceId: session.lease.workspaceId,
      generation: session.lease.generation,
      token: session.lease.token,
    });
    await titleReadEntered;
    const stopping = session.stop();
    await new Promise(resolveWait => setTimeout(resolveWait, 25));

    expect(closeSpy).not.toHaveBeenCalled();
    releaseTitleRead();
    await expect(idempotentClaim).resolves.toMatchObject({ browser: { running: true, title: "linearized" } });
    await expect(stopping).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(browserSandbox._destroy).toHaveBeenCalledOnce();
    expect(internals.sessions.size).toBe(0);
  });

  it("rejects invalid control-plane claims before changing sandbox state", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-sandbox-control-token-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 2, idleTtlMs: 60_000, isolation: "none",
      commandTimeoutMs: 10_000, workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
    });
    const server = await runtime.start();
    cleanups.push(async () => { await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
    const leases = new InMemorySandboxLeaseStore({ replicas: 1, maxSessionsPerReplica: 2, idleTtlMs: 60_000, encryptionKey: "test-key" });
    await leases.init();
    const scope = { applicationId: "qasey", tenantId: "tenant", sessionId: "signed-session" };
    const lease = await leases.acquire(scope);
    const claim = {
      sessionId: lease.sessionId,
      workspaceId: lease.workspaceId,
      generation: lease.generation,
      token: lease.token,
      githubToken: "synthetic-installation-token-0000000000",
    };
    const endpoint = `http://127.0.0.1:${server.port}`;
    const capacity = async () => fetch(`${endpoint}/capacity`).then(response => response.json()) as Promise<{ active: number }>;

    await expect(postClaim(endpoint, claim)).resolves.toHaveProperty("status", 401);
    await expect(capacity()).resolves.toMatchObject({ active: 0 });

    const expired = await signSandboxControlToken({
      controlKey: TEST_CONTROL_KEY,
      scope,
      claim,
      now: new Date(Date.now() - 120_000),
    });
    await expect(postClaim(endpoint, claim, expired)).resolves.toHaveProperty("status", 401);
    await expect(capacity()).resolves.toMatchObject({ active: 0 });

    const valid = await signSandboxControlToken({ controlKey: TEST_CONTROL_KEY, scope, claim });
    await expect(postClaim(endpoint, claim, tamperSignature(valid))).resolves.toHaveProperty("status", 401);
    await expect(postClaim(endpoint, { ...claim, workspaceId: "f".repeat(64) }, valid)).resolves.toHaveProperty("status", 401);
    await expect(postClaim(endpoint, { ...claim, githubToken: "different-installation-token-000000000000" }, valid)).resolves.toHaveProperty("status", 401);
    await expect(postClaim(endpoint, { ...claim, unexpected: "strict-body-change" }, valid)).resolves.toHaveProperty("status", 401);
    await expect(capacity()).resolves.toMatchObject({ active: 0 });

    await expect(postClaim(endpoint, claim, valid)).resolves.toHaveProperty("status", 200);
    await expect(capacity()).resolves.toMatchObject({ active: 1 });
    await expect(postClaim(endpoint, { ...claim, generation: claim.generation + 1 }, valid)).resolves.toHaveProperty("status", 401);

    const originalSession = await fetch(`${endpoint}/v1/sessions/${encodeURIComponent(claim.sessionId)}/filesystem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qasey-session-token": claim.token,
        "x-qasey-lease-generation": String(claim.generation),
      },
      body: JSON.stringify({ operation: "exists", path: "claim-remains-active" }),
    });
    expect(originalSession.status).toBe(200);
  });

  it("enforces one worker per session and cancels the complete worker process group", async () => {
    vi.stubEnv("OPENAI_API_KEY", "model-key-visible-only-to-agent-profiles");
    vi.stubEnv("GITHUB_TOKEN", "github-token-must-not-reach-worker");
    vi.stubEnv("QASEY_DEV_AUTH_TOKEN", "control-plane-token-must-not-reach-worker");
    let markFirstPreparationEntered!: () => void;
    let releaseFirstPreparation!: () => void;
    const firstPreparationEntered = new Promise<void>(resolveWait => { markFirstPreparationEntered = resolveWait; });
    const firstPreparationReleased = new Promise<void>(resolveWait => { releaseFirstPreparation = resolveWait; });
    let blockFirstPreparation = true;
    const dataRoot = await mkdtemp(join(tmpdir(), "qasey-code-task-runtime-"));
    const runtime = new QaseySandboxRuntime({
      dataRoot, port: 0, host: "127.0.0.1", maxSessions: 1, idleTtlMs: 60_000, isolation: "none", commandTimeoutMs: 10_000,
      workspaceRetentionMs: 60_000, controlKey: TEST_CONTROL_KEY,
      codeTaskWorkerPath: resolve("tests/fixtures/code-task-hanging-worker.mjs"),
      codeTaskRepositoryPreparer: async (_repositoryRoot, _spec, taskRoot) => {
        if (blockFirstPreparation) {
          blockFirstPreparation = false;
          markFirstPreparationEntered();
          await firstPreparationReleased;
        }
        const workspace = join(taskRoot, "repositories", "target");
        await mkdir(workspace, { recursive: true });
        return workspace;
      },
    });
    const server = await runtime.start();
    cleanups.push(async () => { await server.close(); await rm(dataRoot, { recursive: true, force: true }); });
    const leases = new InMemorySandboxLeaseStore({ replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key" });
    await leases.init();
    const pool = new SandboxPoolClient(leases, { endpointTemplate: `http://127.0.0.1:${server.port}`, requestTimeoutMs: 10_000, controlKey: TEST_CONTROL_KEY });
    const session = await pool.session({ applicationId: "qasey", tenantId: "tenant", sessionId: "code-task-session" });
    const context = "frozen context";
    const spec = {
      taskId: "task-1", attemptId: "attempt-1", kind: "author" as const,
      scope: { applicationId: "qasey", tenantId: "tenant", sessionId: "code-task-session" },
      contextRef: { id: "context", kind: "report" as const, name: "context.json", uri: "sandbox://context.json" },
      contextHash: createHash("sha256").update(context).digest("hex"),
      repositories: [{ owner: "example-org", repository: "web-e2e", destination: "target", mode: "write" as const, baseRef: "main", baseSha: "a".repeat(40) }],
      baseSha: "a".repeat(40), executionProfileId: "web-e2e-author" as const, allowedPaths: ["tests"], fixedChecks: [], deadlineMs: 60_000, traceContext: {},
    };

    const firstStart = session.codeTaskStart(spec, context);
    await firstPreparationEntered;
    const concurrentSpec = { ...spec, taskId: "task-concurrent", attemptId: "attempt-concurrent" };
    const concurrentStart = session.codeTaskStart(concurrentSpec, context);
    const concurrentError = await concurrentStart.then(() => undefined, error => error as unknown);
    releaseFirstPreparation();
    const concurrentResults = await Promise.allSettled([firstStart, concurrentStart]);
    expect(concurrentResults[0]).toMatchObject({ status: "fulfilled", value: { status: "queued" } });
    expect(concurrentResults[1]).toMatchObject({ status: "rejected" });
    expect(concurrentError).toBeInstanceOf(Error);
    expect(String(concurrentError)).toMatch(/already starting code task task-1/u);
    await waitUntil(async () => (await session.codeTaskState(spec.taskId)).status === "running");
    await expect(session.codeTaskStart({ ...spec, taskId: "task-2", attemptId: "attempt-2" }, context)).rejects.toThrow(/already running/u);
    const attemptRoot = join(dataRoot, "code-tasks", session.lease.workspaceId, "task-1", "attempt-1");
    const artifactPrefix = "code-task-artifacts/task-1/attempt-1";
    await waitUntil(async () => {
      return Promise.all([
        access(join(attemptRoot, "artifacts", "child.pid")),
        access(join(attemptRoot, "artifacts", "credential-presence.json")),
      ]).then(() => true, () => false);
    });
    await expect(session.filesystem({ operation: "readFile", path: `${artifactPrefix}/credential-presence.json`, encoding: "utf8" }))
      .rejects.toThrow(/while the task is active/u);
    await expect(session.filesystem<{ exists: boolean }>({ operation: "exists", path: "code-tasks/task-1/attempt-1/control/state.json" }))
      .resolves.toEqual({ exists: false });
    const childPid = Number(await readFile(join(attemptRoot, "artifacts", "child.pid"), "utf8"));
    expect(processExists(childPid)).toBe(true);
    expect(JSON.parse(await readFile(join(attemptRoot, "artifacts", "credential-presence.json"), "utf8"))).toEqual({
      modelInInitialEnvironment: false,
      modelReceivedInMemory: true,
      modelCanaryInWorkerOrChildProc: false,
      github: false,
      controlPlane: false,
      repositoryBroker: false,
    });
    const removedBroker = await fetch(`${session.endpoint}/v1/sessions/${encodeURIComponent(spec.scope.sessionId)}/repositories/clone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qasey-session-token": session.lease.token,
        "x-qasey-lease-generation": String(session.lease.generation),
      },
      body: JSON.stringify({ repository: "example-org/web-e2e", destination: "not-created", bare: false }),
    });
    expect(removedBroker.status).toBe(404);

    const cancellations = await Promise.all([
      session.codeTaskCancel(spec.taskId, "test cancellation"),
      session.codeTaskCancel(spec.taskId, "test cancellation"),
    ]);
    expect(cancellations).toEqual([
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "cancelled" }),
    ]);
    await waitUntil(async () => !processExists(childPid));
    let completedArtifact: { content: string; encoding: string } | undefined;
    await waitUntil(async () => {
      completedArtifact = await session.filesystem<{ content: string; encoding: string }>({
        operation: "readFile", path: `${artifactPrefix}/credential-presence.json`, encoding: "utf8",
      }).catch(() => undefined);
      return Boolean(completedArtifact);
    });
    expect(JSON.parse(completedArtifact!.content)).toMatchObject({ modelReceivedInMemory: true, repositoryBroker: false });
    await expect(session.filesystem({ operation: "readFile", path: `${artifactPrefix}/escaping-link`, encoding: "utf8" }))
      .rejects.toThrow(/escaped.*artifact root/iu);
    const events = await session.codeTaskEvents(spec.taskId);
    expect(events.events.map(event => event.type)).toEqual(expect.arrayContaining(["task.cancel_requested", "task.cancelled"]));
    expect(events.events.findIndex(event => event.type === "task.cancel_requested"))
      .toBeLessThan(events.events.findIndex(event => event.type === "task.cancelled"));
    const cursors = events.events.map(event => Number(event.cursor));
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors).toEqual([...cursors].sort((left, right) => left - right));
    expect(events.events.filter(event => event.type === "task.cancel_requested")).toHaveLength(1);
    expect(events.events.filter(event => event.type === "task.cancelled")).toHaveLength(1);
    const firstCursor = events.events[0]?.cursor;
    if (!firstCursor) throw new Error("Expected at least one Code Task event");
    await expect(session.codeTaskEvents(spec.taskId, firstCursor)).resolves.toMatchObject({
      events: events.events.slice(1),
    });

    const delayedSpec = { ...spec, taskId: "terminal-delay-1", attemptId: "terminal-delay-attempt-1" };
    await expect(session.codeTaskStart(delayedSpec, context)).resolves.toMatchObject({ status: "queued" });
    const delayedAttemptRoot = join(
      dataRoot, "code-tasks", session.lease.workspaceId, delayedSpec.taskId, delayedSpec.attemptId,
    );
    const delayedArtifactPath = `${delayedSpec.taskId}/${delayedSpec.attemptId}/delayed-terminal.txt`;
    await waitUntil(async () => {
      const state = await readFile(join(delayedAttemptRoot, "control", "state.json"), "utf8")
        .then(value => JSON.parse(value) as { status?: string }).catch(() => undefined);
      return state?.status === "failed";
    });
    await expect(session.codeTaskState(delayedSpec.taskId)).resolves.toMatchObject({ status: "running" });
    await expect(session.filesystem({
      operation: "readFile",
      path: `code-task-artifacts/${delayedArtifactPath}`,
      encoding: "utf8",
    })).rejects.toThrow(/while the task is active/u);
    await waitUntil(async () => (await session.codeTaskState(delayedSpec.taskId)).status === "failed");
    await expect(session.filesystem<{ content: string }>({
      operation: "readFile",
      path: `code-task-artifacts/${delayedArtifactPath}`,
      encoding: "utf8",
    })).resolves.toMatchObject({ content: "terminal artifact\n" });

    const nextSpec = { ...spec, taskId: "terminal-delay-2", attemptId: "terminal-delay-attempt-2" };
    await expect(session.codeTaskStart(nextSpec, context)).resolves.toMatchObject({ status: "queued" });
    await waitUntil(async () => (await session.codeTaskState(nextSpec.taskId)).status === "failed");
  });
});

async function postClaim(endpoint: string, claim: object, controlToken?: string): Promise<Response> {
  return fetch(`${endpoint}/v1/sessions/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(controlToken ? { authorization: `Bearer ${controlToken}` } : {}),
    },
    body: JSON.stringify(claim),
  });
}

function tamperSignature(token: string): string {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("Expected a compact JWT");
  const replacement = signature.startsWith("a") ? "b" : "a";
  return `${header}.${payload}.${replacement}${signature.slice(1)}`;
}

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

function fakeHeadlessBrowser() {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue(""),
    url: vi.fn().mockReturnValue("about:blank"),
  };
  const context = {
    route: vi.fn().mockResolvedValue(undefined),
    routeWebSocket: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browserMock = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser: browserMock as unknown as Browser, browserMock, context, page };
}
