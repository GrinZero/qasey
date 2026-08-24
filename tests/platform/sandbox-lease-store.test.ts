import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { InMemorySandboxLeaseStore, PrismaSandboxLeaseStore, SandboxCapacityError } from "../../src/platform/workspace/sandbox-lease-store.ts";
import { decryptSandboxSecret, encryptSandboxSecret } from "../../src/platform/workspace/sandbox-secrets.ts";

describe("sandbox lease store", () => {
  it("balances leases and enforces the fixed pool capacity", async () => {
    const store = new InMemorySandboxLeaseStore({ replicas: 2, maxSessionsPerReplica: 2, idleTtlMs: 60_000, encryptionKey: "test-key" });
    const leases = await Promise.all([0, 1, 2, 3].map(index => store.acquire({ applicationId: "qasey", tenantId: "tenant", sessionId: `session-${index}` })));
    expect(leases.map(lease => lease.ordinal)).toEqual([0, 1, 0, 1]);
    await expect(store.acquire({ applicationId: "qasey", tenantId: "tenant", sessionId: "session-4" })).rejects.toBeInstanceOf(SandboxCapacityError);
    await store.release({ applicationId: "qasey", tenantId: "tenant", sessionId: "session-0" });
    await expect(store.acquire({ applicationId: "qasey", tenantId: "tenant", sessionId: "session-4" })).resolves.toMatchObject({ ordinal: 0 });
  });

  it("keeps a stable workspace and rotates credentials after an idle release", async () => {
    const store = new InMemorySandboxLeaseStore({ replicas: 1, maxSessionsPerReplica: 1, idleTtlMs: 60_000, encryptionKey: "test-key" });
    const scope = { applicationId: "qasey", tenantId: "tenant", sessionId: "session" };
    const first = await store.acquire(scope);
    expect(await store.acquire(scope)).toMatchObject({ workspaceId: first.workspaceId, generation: 1, token: first.token });
    await store.release(scope);
    const resumed = await store.acquire(scope);
    expect(resumed.workspaceId).toBe(first.workspaceId);
    expect(resumed.generation).toBe(2);
    expect(resumed.token).not.toBe(first.token);
  });

  it("moves a lease to another replica when its sandbox pod is unavailable", async () => {
    const store = new InMemorySandboxLeaseStore({ replicas: 2, maxSessionsPerReplica: 5, idleTtlMs: 60_000, encryptionKey: "test-key" });
    const scope = { applicationId: "qasey", tenantId: "tenant", sessionId: "session" };
    const first = await store.acquire(scope);
    const reassigned = await store.reassign(scope, first.ordinal);

    expect(reassigned.ordinal).not.toBe(first.ordinal);
    expect(reassigned.workspaceId).toBe(first.workspaceId);
    expect(reassigned.generation).toBe(first.generation + 1);
    expect(reassigned.token).not.toBe(first.token);
  });

  it("encrypts persisted session credentials", () => {
    const encrypted = encryptSandboxSecret("secret-token", "master-key");
    expect(encrypted).not.toContain("secret-token");
    expect(decryptSandboxSecret(encrypted, "master-key")).toBe("secret-token");
    expect(() => decryptSandboxSecret(encrypted, "wrong-key")).toThrow();
  });

  it("casts the PostgreSQL advisory lock result to a Prisma-supported type", async () => {
    const lockQueries: string[] = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        if (sql.includes("pg_advisory_xact_lock")) {
          lockQueries.push(sql);
          if (!sql.includes("::text")) throw new Error("Failed to deserialize column of type 'void'");
          return [{ lock: "" }];
        }
        return [];
      },
      qaseySandboxLease: {
        updateMany: async () => ({ count: 0 }),
        groupBy: async () => [],
        upsert: async ({ create }: { create: Record<string, unknown> }) => ({
          id: "lease-id",
          ...create,
          createdAt: new Date(),
        }),
      },
    };
    const prisma = {
      $connect: async () => undefined,
      $transaction: async (operation: (client: typeof tx) => unknown) => operation(tx),
    } as unknown as PrismaClient;
    const store = new PrismaSandboxLeaseStore(prisma, {
      replicas: 1,
      maxSessionsPerReplica: 1,
      idleTtlMs: 60_000,
      encryptionKey: "test-key",
    });

    await store.init();
    await expect(store.acquire({ applicationId: "qasey", tenantId: "tenant", sessionId: "session" })).resolves.toMatchObject({
      applicationId: "qasey",
      tenantId: "tenant",
      sessionId: "session",
      ordinal: 0,
    });
    expect(lockQueries).toHaveLength(1);
  });
});
