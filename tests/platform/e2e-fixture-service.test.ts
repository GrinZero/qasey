import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildMetadata } from "../../src/platform/e2e/build-metadata.ts";
import { E2EFixtureLeaseService } from "../../src/platform/e2e/fixture-service.ts";
import { SandboxCodeTaskStartSchema } from "../../src/platform/workspace/sandbox-protocol.ts";

describe("E2E build metadata", () => {
  it("resolves the current commit from Git metadata without a Qasey environment variable", () => {
    const root = mkdtempSync(join(tmpdir(), "qasey-build-metadata-"));
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    expect(resolveBuildMetadata(root)).toEqual({ schemaVersion: 1, sourceSha: "a".repeat(40) });
  });

  it("uses the generated build artifact when the runtime image has no Git directory", () => {
    const root = mkdtempSync(join(tmpdir(), "qasey-build-artifact-"));
    mkdirSync(join(root, ".qasey"), { recursive: true });
    writeFileSync(join(root, ".qasey", "build-metadata.json"), JSON.stringify({ schemaVersion: 1, sourceSha: "b".repeat(40) }));
    expect(resolveBuildMetadata(root).sourceSha).toBe("b".repeat(40));
  });
});

describe("E2E fixture lease service", () => {
  it("checks the deployed SHA, creates an isolated lease, and cleans it up directly", async () => {
    const sourceSha = "a".repeat(40);
    const service = new E2EFixtureLeaseService({ schemaVersion: 1, sourceSha });
    const lease = await service.acquire({ owner: { applicationId: "qasey", tenantId: "tenant-1" }, runId: "run-1", expectedSourceSha: sourceSha, baseUrl: "https://e2e.example.test/" });
    expect(lease).toMatchObject({ baseUrl: "https://e2e.example.test", sourceSha });
    expect(lease.id).toBeTruthy();
    expect(lease.sessionToken).toMatch(/^qsy_session_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u);
    await service.release(lease);
    await service.release(lease);
  });

  it("blocks an environment source mismatch before allocating a lease", async () => {
    const service = new E2EFixtureLeaseService({ schemaVersion: 1, sourceSha: "b".repeat(40) });
    await expect(service.acquire({ owner: { applicationId: "qasey", tenantId: "tenant-1" }, runId: "run-1", expectedSourceSha: "a".repeat(40), baseUrl: "https://e2e.example.test" }))
      .rejects.toThrow("environment_version_mismatch");
  });

  it("enforces ownership for the service-only cleanup API", async () => {
    const service = new E2EFixtureLeaseService({ schemaVersion: 1, sourceSha: "a".repeat(40) });
    const lease = await service.create("service-a", 60);
    await expect(service.isActiveFixtureUser(lease.organizationId, lease.userId)).resolves.toBe(true);
    await expect(service.deleteForOwner("service-b", lease.id)).resolves.toBe("forbidden");
    await expect(service.deleteForOwner("service-a", lease.id)).resolves.toBe("deleted");
    await expect(service.isActiveFixtureUser(lease.organizationId, lease.userId)).resolves.toBe(false);
  });

  it("rejects incomplete per-run secret payloads", () => {
    const base = {
      spec: {
        taskId: "task", attemptId: "attempt", kind: "author", scope: { applicationId: "qasey", tenantId: "tenant-1", sessionId: "session" },
        contextRef: { id: "context", kind: "context", uri: "sandbox://context" }, contextHash: "a".repeat(64),
        repositories: [{ owner: "example", repository: "web", destination: "target", mode: "write", baseRef: "main", baseSha: "a".repeat(40) }],
        baseSha: "a".repeat(40), executionProfileId: "web-e2e-verifier", allowedPaths: ["e2e"], fixedChecks: [], deadlineMs: 60_000, traceContext: {},
      },
      context: "frozen",
    };
    expect(SandboxCodeTaskStartSchema.safeParse({ ...base, secrets: { environment: { QASEY_E2E_SESSION_TOKEN: "s".repeat(32) } } }).success).toBe(false);
  });
});
