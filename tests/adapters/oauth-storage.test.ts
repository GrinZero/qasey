import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaOAuthStorage, PrismaOAuthStorageBackend } from "../../packages/adapters/src/oauth-storage.ts";

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
    const first = new PrismaOAuthStorage(backend, "0123456789abcdef0123456789abcdef", "qasey:first:figma");
    const second = new PrismaOAuthStorage(backend, "0123456789abcdef0123456789abcdef", "qasey:second:figma");

    await expect(first.set("tokens", "secret")).rejects.toThrow("has not been initialized");
    expect(database.qaseyMcpOAuthCredential.upsert).not.toHaveBeenCalled();

    await backend.init();
    await first.set("tokens", "secret-1");
    await second.set("tokens", "secret-2");

    expect(database.$connect).toHaveBeenCalledOnce();
    expect(database.qaseyMcpOAuthCredential.upsert).toHaveBeenCalledTimes(2);
  });
});
