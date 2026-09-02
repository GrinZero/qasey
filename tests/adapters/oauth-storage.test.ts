import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mcpOAuthCredentialNamespace,
  PrismaOAuthStorage,
  PrismaOAuthStorageBackend,
  type McpOAuthCredentialAddress,
} from "../../packages/adapters/src/oauth-storage.ts";

const addressA: McpOAuthCredentialAddress = {
  owner: { applicationId: "qasey", tenantId: "tenant-a" },
  connectorId: "figma",
  accountId: "user-a",
};
const addressB: McpOAuthCredentialAddress = {
  owner: { applicationId: "qasey", tenantId: "tenant-b" },
  connectorId: "figma",
  accountId: "user-b",
};

const database = {
  $connect: vi.fn(async () => undefined),
  qaseyMcpOAuthCredential: {
    upsert: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
} as unknown as PrismaClient;

describe("Prisma OAuth storage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shares one initialized Prisma client across subject namespaces", async () => {
    const backend = new PrismaOAuthStorageBackend(database);
    const first = new PrismaOAuthStorage(backend, "0123456789abcdef0123456789abcdef", addressA);
    const second = new PrismaOAuthStorage(backend, "0123456789abcdef0123456789abcdef", addressB);

    await expect(first.set("tokens", "secret")).rejects.toThrow("has not been initialized");
    expect(database.qaseyMcpOAuthCredential.upsert).not.toHaveBeenCalled();

    await backend.init();
    await first.set("tokens", "secret-1");
    await second.set("tokens", "secret-2");

    expect(database.$connect).toHaveBeenCalledOnce();
    expect(database.qaseyMcpOAuthCredential.upsert).toHaveBeenCalledTimes(2);
  });

  it("reads legacy values, rotates every untouched record with CAS, and binds new ciphertext to its row", async () => {
    const rows = new Map<string, { namespace: string; storageKey: string; encryptedValue: string }>();
    const rowKey = (namespace: string, storageKey: string) => `${namespace}\0${storageKey}`;
    const client = {
      $connect: vi.fn(async () => undefined),
      $queryRaw: vi.fn(async () => [{ value: 1 }]),
      qaseyMcpOAuthCredential: {
        upsert: vi.fn(async (input: {
          where: { namespace_storageKey: { namespace: string; storageKey: string } };
          create: { namespace: string; storageKey: string; encryptedValue: string };
          update: { encryptedValue: string };
        }) => {
          const identity = input.where.namespace_storageKey;
          rows.set(rowKey(identity.namespace, identity.storageKey), {
            ...identity,
            encryptedValue: rows.has(rowKey(identity.namespace, identity.storageKey))
              ? input.update.encryptedValue
              : input.create.encryptedValue,
          });
          return {};
        }),
        findUnique: vi.fn(async (input: { where: { namespace_storageKey: { namespace: string; storageKey: string } } }) => {
          const identity = input.where.namespace_storageKey;
          const row = rows.get(rowKey(identity.namespace, identity.storageKey));
          return row ? { encryptedValue: row.encryptedValue } : null;
        }),
        findMany: vi.fn(async (input: {
          take: number;
          cursor?: { namespace_storageKey: { namespace: string; storageKey: string } };
        }) => {
          const ordered = [...rows.values()].sort((left, right) =>
            left.namespace.localeCompare(right.namespace) || left.storageKey.localeCompare(right.storageKey));
          const cursor = input.cursor?.namespace_storageKey;
          const start = cursor
            ? ordered.findIndex(row => row.namespace === cursor.namespace && row.storageKey === cursor.storageKey) + 1
            : 0;
          return ordered.slice(start, start + input.take);
        }),
        updateMany: vi.fn(async (input: {
          where: { namespace: string; storageKey: string; encryptedValue: string };
          data: { encryptedValue: string };
        }) => {
          const key = rowKey(input.where.namespace, input.where.storageKey);
          const row = rows.get(key);
          if (!row || row.encryptedValue !== input.where.encryptedValue) return { count: 0 };
          rows.set(key, { ...row, encryptedValue: input.data.encryptedValue });
          return { count: 1 };
        }),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as PrismaClient;
    const backend = new PrismaOAuthStorageBackend(client);
    await backend.init();
    const legacyKey = "legacy-oauth-encryption-key-over-32-bytes";
    const activeKey = "active-oauth-encryption-key-over-32-bytes";
    const namespaceA = mcpOAuthCredentialNamespace(addressA);
    const namespaceB = mcpOAuthCredentialNamespace(addressB);
    const legacy = new PrismaOAuthStorage(backend, legacyKey, addressA);
    await legacy.set("tokens", "refresh-token-a");
    await legacy.set("metadata", "metadata-a");
    expect(rows.get(rowKey(namespaceA, "tokens"))?.encryptedValue).toMatch(/^v1\./u);

    const rotatingKeyring = {
      activeKeyId: "oauth-2026-09",
      keys: { default: legacyKey, "oauth-2026-09": activeKey },
    };
    await expect(backend.rotateAll(rotatingKeyring, 1)).resolves.toBe(2);
    const encrypted = rows.get(rowKey(namespaceA, "tokens"))!.encryptedValue;
    expect(encrypted).toMatch(/^v2\.oauth-2026-09\./u);

    const activeOnly = new PrismaOAuthStorage(backend, {
      activeKeyId: "oauth-2026-09",
      keys: { "oauth-2026-09": activeKey },
    }, addressA);
    await expect(activeOnly.get("tokens")).resolves.toBe("refresh-token-a");

    await backend.set(addressB, "tokens", encrypted);
    expect(rows.has(rowKey(namespaceB, "tokens"))).toBe(true);
    const wrongRow = new PrismaOAuthStorage(backend, rotatingKeyring, addressB);
    await expect(wrongRow.get("tokens")).rejects.toThrow("could not be decrypted");
    const oldOnly = new PrismaOAuthStorage(backend, legacyKey, addressA);
    await expect(oldOnly.get("tokens")).rejects.toThrow("could not be decrypted");
  });

  it("fails closed when rotation encounters a non-canonical persisted namespace", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const client = {
      $connect: vi.fn(async () => undefined),
      qaseyMcpOAuthCredential: {
        findMany: vi.fn(async () => [{
          namespace: "legacy:caller-controlled:namespace",
          storageKey: "tokens",
          encryptedValue: "redacted-invalid-envelope",
        }]),
        updateMany,
      },
    } as unknown as PrismaClient;
    const backend = new PrismaOAuthStorageBackend(client);
    await backend.init();

    await expect(backend.rotateAll({
      activeKeyId: "active",
      keys: { active: "synthetic-oauth-encryption-key-at-least-32-bytes" },
    })).rejects.toThrow("namespace is not canonical");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects unbounded or non-canonical connector and account fields before database access", async () => {
    const backend = new PrismaOAuthStorageBackend(database);
    await backend.init();
    expect(() => new PrismaOAuthStorage(backend, "0123456789abcdef0123456789abcdef", {
      owner: { applicationId: "qasey", tenantId: "tenant-a" },
      connectorId: "figma:tenant-b",
      accountId: "user-a",
    })).toThrow();
    expect(() => new PrismaOAuthStorage(backend, "0123456789abcdef0123456789abcdef", {
      owner: { applicationId: "qasey", tenantId: "tenant-a" },
      connectorId: "figma",
      accountId: "x".repeat(256),
    })).toThrow();

    expect(database.qaseyMcpOAuthCredential.upsert).not.toHaveBeenCalled();
  });
});
