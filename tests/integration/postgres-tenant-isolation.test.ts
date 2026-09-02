import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { E2ERun, OwnerScope } from "../../packages/contracts/src/index.ts";
import {
  mcpOAuthCredentialNamespace,
  PrismaOAuthStorage,
  PrismaOAuthStorageBackend,
  type McpOAuthCredentialAddress,
} from "../../packages/adapters/src/oauth-storage.ts";
import { freezeE2EContext } from "../../packages/domain/src/e2e-context.ts";
import { PrismaRunRepository } from "../../packages/domain/src/run-repository.ts";
import { PrismaApiTokenStore } from "../../src/platform/auth/api-token-store.ts";
import { PrismaOrganizationStore } from "../../src/platform/auth/organization-store.ts";
import {
  PrismaExternalConnectionStore,
  type CredentialKeyring,
} from "../../src/platform/connections/connection-store.ts";
import { PrismaEffectReceiptStore } from "../../src/platform/recovery/effect-receipts.ts";
import { PrismaFailureInboxStore } from "../../src/platform/recovery/failure-inbox.ts";
import { createApplicationDatabase } from "../../src/platform/storage/prisma.ts";
import { PrismaSandboxLeaseStore } from "../../src/platform/workspace/sandbox-lease-store.ts";

const testDatabaseUrl = process.env.QASEY_TEST_DATABASE_URL?.trim();
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;

describeWithPostgres("PostgreSQL tenant isolation", () => {
  it("prevents cross-tenant run, event, heartbeat, and CAS access", async () => {
    const database = createApplicationDatabase(requiredTestDatabaseUrl());
    const ownerA = { applicationId: "qasey", tenantId: randomUUID() };
    const ownerB = { applicationId: "qasey", tenantId: randomUUID() };
    const runA = integrationRun(ownerA, randomUUID());
    const runB = integrationRun(ownerB, randomUUID());
    const store = new PrismaRunRepository(database.client);

    try {
      await database.init();
      await store.init();
      await store.create(ownerA, runA);
      await store.create(ownerB, runB);
      await store.addEvent(ownerB, runB.id, "created", "tenant-b event");

      await expect(store.get(ownerA, runB.id)).resolves.toBeUndefined();
      await expect(store.events(ownerA, runB.id)).resolves.toEqual([]);
      await expect(store.heartbeat(ownerA, runB.id)).rejects.toThrow(/not found/u);
      await expect(store.update(ownerA, runB.id, 1, { status: "failed" })).rejects.toThrow(/not found/u);
      await expect(store.list(ownerA)).resolves.toEqual([
        expect.objectContaining({ id: runA.id, tenantId: ownerA.tenantId }),
      ]);
      await expect(store.get(ownerB, runB.id)).resolves.toMatchObject({
        id: runB.id,
        tenantId: ownerB.tenantId,
        revision: 1,
      });
      await expect(store.events(ownerB, runB.id)).resolves.toEqual([
        expect.objectContaining({ runId: runB.id, message: "tenant-b event" }),
      ]);
    } finally {
      try {
        await database.client.agentApplicationRun.deleteMany({
          where: { tenantId: { in: [ownerA.tenantId, ownerB.tenantId] } },
        });
      } finally {
        await database.close();
      }
    }
  });

  it("prevents cross-tenant reads and CAS mutations of external connections", async () => {
    const database = createApplicationDatabase(requiredTestDatabaseUrl());
    const generatedConnectionIds: string[] = [];
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const actorId = `integration-test:${randomUUID()}`;
    const keyring: CredentialKeyring = {
      activeKeyId: "integration-test",
      keys: { "integration-test": "integration-test-credential-key-at-least-32-bytes" },
    };
    const store = new PrismaExternalConnectionStore(database.client, keyring);

    try {
      await database.init();
      await store.init();
      const connectionA = await store.create({
        tenantId: tenantA,
        provider: "jira",
        name: `tenant-a-${randomUUID()}`,
        configuration: { baseUrl: "https://jira-a.example.com" },
        credentials: { apiKey: "redacted-tenant-a-value" },
        actorId,
      });
      generatedConnectionIds.push(connectionA.id);
      const connectionB = await store.create({
        tenantId: tenantB,
        provider: "jira",
        name: `tenant-b-${randomUUID()}`,
        configuration: { baseUrl: "https://jira-b.example.com" },
        credentials: { apiKey: "redacted-tenant-b-value" },
        actorId,
      });
      generatedConnectionIds.push(connectionB.id);

      await expect(store.get(tenantA, connectionB.id)).resolves.toBeUndefined();
      await expect(store.getRuntime(tenantA, connectionB.id)).resolves.toBeUndefined();
      await expect(store.list(tenantA, "jira")).resolves.toEqual([
        expect.objectContaining({ id: connectionA.id, tenantId: tenantA }),
      ]);
      await expect(store.update({
        tenantId: tenantA,
        id: connectionB.id,
        expectedRevision: connectionB.revision,
        status: "disabled",
        actorId,
      })).rejects.toMatchObject({ code: "not_found" });
      await expect(store.rotate(
        tenantA,
        connectionB.id,
        connectionB.revision,
        actorId,
      )).rejects.toMatchObject({ code: "not_found" });
      await expect(store.update({
        tenantId: tenantB,
        id: connectionB.id,
        expectedRevision: connectionB.revision + 1,
        status: "disabled",
        actorId,
      })).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(store.revoke(
        tenantB,
        randomUUID(),
        connectionB.revision,
        actorId,
      )).rejects.toMatchObject({ code: "not_found" });

      await expect(store.get(tenantB, connectionB.id)).resolves.toEqual(connectionB);
      await expect(store.getRuntime(tenantB, connectionB.id)).resolves.toMatchObject({
        id: connectionB.id,
        tenantId: tenantB,
        revision: connectionB.revision,
        status: "active",
        credentials: { apiKey: "redacted-tenant-b-value" },
      });
    } finally {
      try {
        if (generatedConnectionIds.length > 0) {
          await database.client.platformExternalConnection.deleteMany({
            where: { id: { in: generatedConnectionIds } },
          });
        }
      } finally {
        await database.close();
      }
    }
  });

  it("prevents cross-tenant API-token revocation and creator-wide writes", async () => {
    const database = createApplicationDatabase(requiredTestDatabaseUrl());
    const generatedTokenIds: string[] = [];
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const sharedCreator = `integration-test:${randomUUID()}`;
    const store = new PrismaApiTokenStore(database.client);

    try {
      await database.init();
      await store.init();
      const tokenA = await store.create({
        tenantId: tenantA,
        name: `tenant-a-${randomUUID()}`,
        scopes: ["qasey.runs.read"],
        createdBy: sharedCreator,
      });
      generatedTokenIds.push(tokenA.record.id);
      const tokenB = await store.create({
        tenantId: tenantB,
        name: `tenant-b-${randomUUID()}`,
        scopes: ["qasey.runs.read"],
        createdBy: sharedCreator,
      });
      generatedTokenIds.push(tokenB.record.id);

      await expect(store.list(tenantA)).resolves.toEqual([
        expect.objectContaining({ id: tokenA.record.id, tenantId: tenantA }),
      ]);
      await expect(store.revoke(tenantA, tokenB.record.id)).resolves.toBe(false);
      await expect(store.revoke(tenantA, randomUUID())).resolves.toBe(false);
      await expect(store.revokeByCreator(tenantA, sharedCreator)).resolves.toBe(1);

      await expect(store.authenticate(tokenA.token)).resolves.toBeUndefined();
      await expect(store.authenticate(tokenB.token)).resolves.toMatchObject({
        tenantId: tenantB,
        tokenId: tokenB.record.id,
      });
      const tenantBTokens = await store.list(tenantB);
      expect(tenantBTokens).toEqual([
        expect.objectContaining({ id: tokenB.record.id, tenantId: tenantB }),
      ]);
      expect(tenantBTokens[0]?.revokedAt).toBeUndefined();
    } finally {
      try {
        if (generatedTokenIds.length > 0) {
          await database.client.platformApiToken.deleteMany({
            where: { id: { in: generatedTokenIds } },
          });
        }
      } finally {
        await database.close();
      }
    }
  });

  it("enforces owner scope for membership writes and session revocation", async () => {
    const database = createApplicationDatabase(requiredTestDatabaseUrl());
    const organizationIds: string[] = [];
    const userIds: string[] = [];
    const sessionIds: string[] = [];
    const store = new PrismaOrganizationStore(database.client);

    try {
      await database.init();
      await store.init();
      const organizationA = await store.createOrganization({
        id: randomUUID(),
        slug: `integration-a-${randomUUID()}`,
        displayName: "Synthetic tenant A",
      });
      organizationIds.push(organizationA.id);
      const organizationB = await store.createOrganization({
        id: randomUUID(),
        slug: `integration-b-${randomUUID()}`,
        displayName: "Synthetic tenant B",
      });
      organizationIds.push(organizationB.id);
      const sharedUser = await store.createUser({ displayName: "Synthetic shared user" });
      userIds.push(sharedUser.id);
      const nonMember = await store.createUser({ displayName: "Synthetic non-member" });
      userIds.push(nonMember.id);
      const ownerA = { applicationId: "platform", tenantId: organizationA.id };
      const ownerB = { applicationId: "platform", tenantId: organizationB.id };
      await store.grantBootstrapMembership({ organizationId: organizationA.id, userId: sharedUser.id });
      await store.grantBootstrapMembership({ organizationId: organizationB.id, userId: sharedUser.id });
      const sessionA = await store.createBrowserSession({
        organizationId: organizationA.id,
        userId: sharedUser.id,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      const sessionB = await store.createBrowserSession({
        organizationId: organizationB.id,
        userId: sharedUser.id,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      sessionIds.push(sessionA.session.id, sessionB.session.id);

      await expect(store.listMemberships(organizationA.id)).resolves.toEqual([
        expect.objectContaining({ organizationId: organizationA.id, userId: sharedUser.id, status: "active" }),
      ]);
      await expect(store.updateMembershipStatus(ownerA, {
        organizationId: organizationB.id,
        userId: sharedUser.id,
        status: "suspended",
      })).rejects.toMatchObject({ code: "organization_scope_mismatch" });
      await expect(store.updateMembershipStatus(ownerA, {
        organizationId: organizationA.id,
        userId: nonMember.id,
        status: "active",
      })).rejects.toMatchObject({ code: "organization_membership_not_found" });
      await expect(store.resolveMembership(organizationA.id, nonMember.id)).resolves.toBeUndefined();

      const concurrentAuthentications = await Promise.all(
        Array.from({ length: 8 }, () => store.authenticateBrowserSession(sessionB.token)),
      );
      expect(concurrentAuthentications).toHaveLength(8);
      expect(concurrentAuthentications.every(authenticated =>
        authenticated?.session.id === sessionB.session.id
        && authenticated.membership.status === "active",
      )).toBe(true);

      await expect(store.updateMembershipStatus(ownerA, {
        organizationId: organizationA.id,
        userId: sharedUser.id,
        status: "suspended",
      })).resolves.toMatchObject({ status: "suspended" });
      await expect(store.authenticateBrowserSession(sessionA.token)).resolves.toBeUndefined();
      await expect(store.revokeBrowserSession(ownerA, sessionB.session.id)).resolves.toBe(false);
      await expect(store.authenticateBrowserSession(sessionB.token)).resolves.toMatchObject({
        session: { id: sessionB.session.id, organizationId: organizationB.id, userId: sharedUser.id },
        membership: { organizationId: organizationB.id, userId: sharedUser.id, status: "active" },
      });

      await expect(store.revokeBrowserSession(ownerB, sessionB.session.id)).resolves.toBe(true);
      await expect(store.authenticateBrowserSession(sessionB.token)).resolves.toBeUndefined();
      await expect(store.resolveActiveMembership(organizationB.id, sharedUser.id)).resolves.toMatchObject({
        organizationId: organizationB.id,
        userId: sharedUser.id,
        status: "active",
      });
    } finally {
      try {
        if (sessionIds.length > 0) {
          await database.client.platformBrowserSession.deleteMany({ where: { id: { in: sessionIds } } });
        }
        if (organizationIds.length > 0 || userIds.length > 0) {
          await database.client.platformOrganizationMembership.deleteMany({
            where: {
              ...(organizationIds.length > 0 ? { organizationId: { in: organizationIds } } : {}),
              ...(userIds.length > 0 ? { userId: { in: userIds } } : {}),
            },
          });
        }
        if (userIds.length > 0) {
          await database.client.platformUser.deleteMany({ where: { id: { in: userIds } } });
        }
        if (organizationIds.length > 0) {
          await database.client.platformOrganization.deleteMany({ where: { id: { in: organizationIds } } });
        }
      } finally {
        await database.close();
      }
    }
  });

  it("prevents a tenant from touching, releasing, or reassigning another tenant's sandbox lease", async () => {
    const database = createApplicationDatabase(requiredTestDatabaseUrl());
    const sharedSessionId = randomUUID();
    const scopeA = { applicationId: "qasey", tenantId: randomUUID(), sessionId: sharedSessionId };
    const scopeB = { applicationId: "qasey", tenantId: randomUUID(), sessionId: sharedSessionId };
    const store = new PrismaSandboxLeaseStore(database.client, {
      replicas: 4,
      maxSessionsPerReplica: 100,
      idleTtlMs: 60_000,
      encryptionKey: "synthetic-integration-sandbox-key",
    });

    try {
      await database.init();
      await store.init();
      const leaseB = await store.acquire(scopeB);

      await store.touch(scopeA);
      await store.release(scopeA);
      await expect(store.reassign(scopeA, leaseB.ordinal)).rejects.toThrow(/does not exist/u);
      await expect(store.acquire(scopeB)).resolves.toMatchObject({
        ...scopeB,
        workspaceId: leaseB.workspaceId,
        generation: leaseB.generation,
        token: leaseB.token,
        state: "active",
      });

      const leaseA = await store.acquire(scopeA);
      expect(leaseA.workspaceId).not.toBe(leaseB.workspaceId);
      expect(leaseA.token).not.toBe(leaseB.token);
      await store.release(scopeA);
      const reassignedB = await store.reassign(scopeB, leaseB.ordinal);
      expect(reassignedB).toMatchObject({
        ...scopeB,
        workspaceId: leaseB.workspaceId,
        generation: leaseB.generation + 1,
        state: "active",
      });
      expect(reassignedB.ordinal).not.toBe(leaseB.ordinal);
      expect(reassignedB.token).not.toBe(leaseB.token);
    } finally {
      try {
        await database.client.qaseySandboxLease.deleteMany({
          where: {
            OR: [scopeA, scopeB],
          },
        });
      } finally {
        await database.close();
      }
    }
  });

  it("prevents cross-tenant failure claims, redrive transitions, and effect-receipt completion", async () => {
    const database = createApplicationDatabase(requiredTestDatabaseUrl());
    const ownerA = { applicationId: "qasey", tenantId: randomUUID() };
    const ownerB = { applicationId: "qasey", tenantId: randomUUID() };
    const runA = integrationRun(ownerA, randomUUID());
    const runB = integrationRun(ownerB, randomUUID());
    const runStore = new PrismaRunRepository(database.client);
    const failures = new PrismaFailureInboxStore(database.client);
    const effects = new PrismaEffectReceiptStore(database.client);

    try {
      await database.init();
      await Promise.all([runStore.init(), failures.init(), effects.init()]);
      await runStore.create(ownerA, runA);
      await runStore.create(ownerB, runB);
      const failureB = await failures.record({
        ...ownerB,
        runId: runB.id,
        workflowId: "synthetic-integration-workflow",
        reasonCode: "heartbeat_timeout",
        errorCode: "SYNTHETIC_TIMEOUT",
        message: "Synthetic redacted timeout",
      });

      await expect(failures.get(ownerA, failureB.id)).resolves.toBeUndefined();
      await expect(failures.list(ownerA)).resolves.toEqual([]);
      await expect(
        failures.claim(ownerA, failureB.id, failureB.revision, `integration-actor:${randomUUID()}`),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        failures.closeItem(ownerA, failureB.id, failureB.revision, `integration-actor:${randomUUID()}`),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        failures.complete(
          ownerA,
          failureB.id,
          failureB.revision,
          `integration-actor:${randomUUID()}`,
          `synthetic-redrive-${randomUUID()}`,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(failures.get(ownerB, failureB.id)).resolves.toMatchObject({
        status: "pending",
        attempts: 0,
        revision: failureB.revision,
      });

      const claimedB = await failures.claim(
        ownerB,
        failureB.id,
        failureB.revision,
        `integration-actor:${randomUUID()}`,
      );
      const completedB = await failures.complete(
        ownerB,
        claimedB.id,
        claimedB.revision,
        `integration-actor:${randomUUID()}`,
        `synthetic-redrive-${randomUUID()}`,
      );
      expect(completedB).toMatchObject({ status: "redriven", attempts: 1, revision: claimedB.revision + 1 });

      const idempotencyKey = `synthetic-effect-${randomUUID()}`;
      const effectA = await effects.begin({
        ...ownerA,
        idempotencyKey,
        runId: runA.id,
        stepId: "synthetic-step",
        requestHash: `synthetic-hash-${randomUUID()}`,
      });
      const effectB = await effects.begin({
        ...ownerB,
        idempotencyKey,
        runId: runB.id,
        stepId: "synthetic-step",
        requestHash: `synthetic-hash-${randomUUID()}`,
      });
      if (!("leaseToken" in effectA) || !("leaseToken" in effectB)) {
        throw new Error("Synthetic effect receipt unexpectedly returned a cached result");
      }

      await expect(effects.get(ownerA, idempotencyKey)).resolves.toMatchObject({
        tenantId: ownerA.tenantId,
        status: "pending",
        revision: 1,
      });
      await expect(effects.get(ownerB, idempotencyKey)).resolves.toMatchObject({
        tenantId: ownerB.tenantId,
        status: "pending",
        revision: 1,
      });
      await expect(
        effects.succeed(ownerA, idempotencyKey, effectB.leaseToken, { outcome: "must-not-write" }),
      ).rejects.toMatchObject({ code: "lease_lost" });
      await expect(effects.get(ownerB, idempotencyKey)).resolves.toMatchObject({
        status: "pending",
        revision: 1,
      });

      await expect(
        effects.succeed(ownerB, idempotencyKey, effectB.leaseToken, { outcome: "synthetic-success" }),
      ).resolves.toMatchObject({ status: "succeeded", revision: 2, result: { outcome: "synthetic-success" } });
      await expect(
        effects.fail(ownerA, idempotencyKey, effectA.leaseToken, "SYNTHETIC_FAILURE", false),
      ).resolves.toMatchObject({ status: "failed", revision: 2, lastErrorCode: "SYNTHETIC_FAILURE" });
    } finally {
      try {
        await database.client.agentApplicationRun.deleteMany({
          where: {
            OR: [
              { applicationId: ownerA.applicationId, tenantId: ownerA.tenantId, id: runA.id },
              { applicationId: ownerB.applicationId, tenantId: ownerB.tenantId, id: runB.id },
            ],
          },
        });
      } finally {
        await database.close();
      }
    }
  });

  it("derives MCP OAuth namespaces from structured owners and scopes every CRUD/CAS operation", async () => {
    const database = createApplicationDatabase(requiredTestDatabaseUrl());
    const backend = new PrismaOAuthStorageBackend(database.client);
    const keyring = {
      activeKeyId: "integration-test",
      keys: { "integration-test": "synthetic-integration-oauth-key-at-least-32-bytes" },
    };
    const addressA: McpOAuthCredentialAddress = {
      owner: { applicationId: "qasey", tenantId: randomUUID() },
      connectorId: "figma",
      accountId: `integration-user-${randomUUID()}`,
    };
    const addressB: McpOAuthCredentialAddress = {
      owner: { applicationId: "qasey", tenantId: randomUUID() },
      connectorId: "figma",
      accountId: `integration-user-${randomUUID()}`,
    };
    const storageKey = `tokens-${randomUUID()}`;
    const namespaceA = mcpOAuthCredentialNamespace(addressA);
    const namespaceB = mcpOAuthCredentialNamespace(addressB);
    const storageA = new PrismaOAuthStorage(backend, keyring, addressA);
    const storageB = new PrismaOAuthStorage(backend, keyring, addressB);

    try {
      await database.init();
      await backend.init();
      await storageB.set(storageKey, "synthetic-redacted-tenant-b-token");
      const encryptedB = await backend.get(addressB, storageKey);
      if (!encryptedB) throw new Error("Synthetic tenant B OAuth row was not created");

      await expect(storageA.get(storageKey)).resolves.toBeUndefined();
      await expect(backend.get(addressA, storageKey)).resolves.toBeUndefined();
      await expect(backend.replace(addressA, storageKey, encryptedB, encryptedB)).resolves.toBe(false);
      await backend.delete(addressA, storageKey);
      await expect(storageB.get(storageKey)).resolves.toBe("synthetic-redacted-tenant-b-token");

      await storageA.set(storageKey, "synthetic-redacted-tenant-a-token");
      const encryptedA = await backend.get(addressA, storageKey);
      expect(encryptedA).toBeDefined();
      expect(encryptedA).not.toBe(encryptedB);
      await expect(backend.replace(addressA, storageKey, encryptedB, encryptedA!)).resolves.toBe(false);
      await expect(storageB.get(storageKey)).resolves.toBe("synthetic-redacted-tenant-b-token");
      await expect(backend.replace(addressB, storageKey, encryptedB, encryptedB)).resolves.toBe(true);
    } finally {
      try {
        await database.client.qaseyMcpOAuthCredential.deleteMany({
          where: {
            OR: [
              { namespace: namespaceA, storageKey },
              { namespace: namespaceB, storageKey },
            ],
          },
        });
      } finally {
        await database.close();
      }
    }
  });
});

function requiredTestDatabaseUrl(): string {
  if (!testDatabaseUrl) throw new Error("QASEY_TEST_DATABASE_URL is required for PostgreSQL tenant-isolation integration tests");
  return testDatabaseUrl;
}

function integrationRun(owner: OwnerScope, id: string): E2ERun {
  const now = new Date().toISOString();
  const contextSnapshot = freezeE2EContext({
    goal: "synthetic integration test",
    requirementSummary: "prove tenant isolation",
    inScope: [],
    outOfScope: [],
    confirmedDecisions: [],
    constraints: [],
    assumptions: [],
    criticalFlows: [],
    boundaryCases: [],
    negativeCases: [],
    testDataNeeds: [],
    repositoryFindings: [],
    blockingQuestions: [],
    evidenceRefs: [],
  }, {
    sessionId: `session-${id}`,
    threadId: `thread-${id}`,
    taskRunId: `task-${id}`,
    requestId: `request-${id}`,
    resourceId: "integration-test",
  });
  return {
    ...owner,
    id,
    requestId: `request-${id}`,
    sourceSessionId: `session-${id}`,
    status: "queued",
    platform: "web",
    framework: "playwright",
    repository: {
      owner: "example-org",
      repository: "synthetic-web-e2e",
      cloneUrl: "https://example.test/synthetic-web-e2e.git",
      baseRef: "main",
      allowedPaths: ["tests"],
      skillsPaths: [],
    },
    changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff",
    contextSnapshot,
    caseSnapshot: [],
    amendments: [],
    codeTaskIds: [],
    artifacts: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}
