import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { E2ERun, OwnerScope } from "../../packages/contracts/src/index.ts";
import { freezeE2EContext } from "../../packages/domain/src/e2e-context.ts";
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

  it("performs owner-scoped run updates as transactional compare-and-set operations", async () => {
    const owner: OwnerScope = { applicationId: "qasey", tenantId: "tenant-1" };
    const run = testRun(owner, "run-1");
    const findUnique = vi.fn(async () => ({ payload: run, revision: 1 }));
    const updateMany = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const executeRaw = vi.fn(async () => 1);
    const transactionClient = { agentApplicationRun: { findUnique, updateMany }, $executeRawUnsafe: executeRaw };
    const transaction = vi.fn(async (operation: (client: typeof transactionClient) => Promise<unknown>) => operation(transactionClient));
    const transactionalDatabase = {
      $connect: vi.fn(async () => undefined),
      $transaction: transaction,
    } as unknown as PrismaClient;
    const repository = new PrismaRunRepository(transactionalDatabase);
    await repository.init();

    const results = await Promise.allSettled([
      repository.update(owner, run.id, 1, { status: "failed" }),
      repository.update(owner, run.id, 1, { status: "failed" }),
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ status: "failed", revision: 2 }) }),
    ]);
    expect(results.filter(result => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({
        name: "RunRevisionConflictError",
        code: "run_revision_conflict",
        runId: run.id,
        expectedRevision: 1,
      }) }),
    ]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { applicationId: owner.applicationId, tenantId: owner.tenantId, id: run.id, revision: 1 },
      data: expect.objectContaining({ revision: { increment: 1 } }),
    }));
  });
});

function testRun(owner: OwnerScope, id: string): E2ERun {
  const now = new Date().toISOString();
  const contextSnapshot = freezeE2EContext({
    goal: "test", requirementSummary: "test", inScope: [], outOfScope: [], confirmedDecisions: [], constraints: [], assumptions: [],
    criticalFlows: [], boundaryCases: [], negativeCases: [], testDataNeeds: [], repositoryFindings: [], blockingQuestions: [], evidenceRefs: [],
  }, { sessionId: "session", threadId: "thread", taskRunId: "task", requestId: "request", resourceId: "test" });
  return {
    ...owner, id, requestId: "request", sourceSessionId: "session", status: "queued", platform: "web", framework: "playwright",
    repository: { owner: "o", repository: "r", cloneUrl: "https://example.test/r.git", baseRef: "main", allowedPaths: ["tests"], skillsPaths: [] }, changeSetId: "97bb25db-18df-428e-af86-be305ad8b2ff",
    contextSnapshot, caseSnapshot: [], amendments: [], codeTaskIds: [], artifacts: [], revision: 1, createdAt: now, updatedAt: now,
  };
}
