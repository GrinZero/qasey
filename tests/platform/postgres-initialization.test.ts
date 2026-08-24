import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaRunRepository } from "../../packages/domain/src/run-repository.ts";
import { PrismaAuditLog } from "../../src/platform/auth/audit-log.ts";
import { PrismaPermissionStore } from "../../src/platform/auth/permission-store.ts";
import { PrismaChannelDeliveryInbox } from "../../src/platform/channels/delivery-inbox.ts";

const database = {
  $connect: vi.fn(async () => undefined),
  $queryRaw: vi.fn(async () => [{ value: 1 }]),
  agentApplicationRun: { findMany: vi.fn(async () => []) },
  platformChannelDelivery: { create: vi.fn(async () => ({})) },
  platformAuditLog: { create: vi.fn(async () => ({})) },
  platformRolePermission: { findMany: vi.fn(async () => []) },
} as unknown as PrismaClient;

describe("Prisma repository initialization", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      name: "run repository",
      create: () => new PrismaRunRepository(database),
      request: (store: PrismaRunRepository) => store.list({ applicationId: "qasey", tenantId: "tenant-1" }),
      operation: () => database.agentApplicationRun.findMany,
    },
    {
      name: "delivery inbox",
      create: () => new PrismaChannelDeliveryInbox(database),
      request: (store: PrismaChannelDeliveryInbox) => store.accept({ applicationId: "qasey", tenantId: "tenant-1" }, "delivery-1"),
      operation: () => database.platformChannelDelivery.create,
    },
    {
      name: "audit log",
      create: () => new PrismaAuditLog(database),
      request: (store: PrismaAuditLog) => store.write({
        requestId: "request-1", resourceType: "agent", resourceId: "qasey-main",
        action: "execute", decision: "allow", reason: "test",
      }),
      operation: () => database.platformAuditLog.create,
    },
    {
      name: "permission store",
      create: () => new PrismaPermissionStore(database),
      request: (store: PrismaPermissionStore) => store.permissionsForRoles("tenant-1", ["user"]),
      operation: () => database.platformRolePermission.findMany,
    },
  ])("connects explicitly and delegates $name queries to Prisma without runtime DDL", async ({ create, request, operation }) => {
    const store = create();

    await expect(request(store as never)).rejects.toThrow("has not been initialized");
    expect(operation()).not.toHaveBeenCalled();

    await store.init();
    expect(database.$connect).toHaveBeenCalledTimes(1);

    await request(store as never);
    expect(operation()).toHaveBeenCalledTimes(1);
  });
});
