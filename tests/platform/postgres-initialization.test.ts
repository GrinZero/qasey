import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({
  query: vi.fn(async (_sql: unknown, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
  connect: vi.fn(),
  end: vi.fn(async () => undefined),
}));

vi.mock("pg", () => ({
  Pool: class {
    query = pg.query;
    connect = pg.connect;
    end = pg.end;
  },
}));

import { PostgresRunRepository } from "../../packages/domain/src/run-repository.ts";
import { PostgresAuditLog } from "../../src/platform/auth/audit-log.ts";
import { PostgresPermissionStore } from "../../src/platform/auth/permission-store.ts";
import { PostgresChannelDeliveryInbox } from "../../src/platform/channels/delivery-inbox.ts";

describe("explicit Postgres initialization", () => {
  beforeEach(() => {
    pg.query.mockClear();
    pg.connect.mockClear();
    pg.end.mockClear();
  });

  it.each([
    {
      name: "run repository",
      create: () => new PostgresRunRepository("postgres://example"),
      request: (store: PostgresRunRepository) => store.list({ applicationId: "qasey", tenantId: "tenant-1" }),
    },
    {
      name: "delivery inbox",
      create: () => new PostgresChannelDeliveryInbox("postgres://example"),
      request: (store: PostgresChannelDeliveryInbox) => store.accept({ applicationId: "qasey", tenantId: "tenant-1" }, "delivery-1"),
    },
    {
      name: "audit log",
      create: () => new PostgresAuditLog("postgres://example"),
      request: (store: PostgresAuditLog) => store.write({
        requestId: "request-1", resourceType: "agent", resourceId: "qasey-main",
        action: "execute", decision: "allow", reason: "test",
      }),
    },
    {
      name: "permission store",
      create: () => new PostgresPermissionStore("postgres://example"),
      request: (store: PostgresPermissionStore) => store.permissionsForRoles("tenant-1", ["user"]),
    },
  ])("never runs DDL from a $name request", async ({ create, request }) => {
    const store = create();

    await expect(request(store as never)).rejects.toThrow("has not been initialized");
    expect(pg.query).not.toHaveBeenCalled();

    await store.init();
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(String(pg.query.mock.calls[0]?.[0])).toContain("CREATE TABLE IF NOT EXISTS");

    await request(store as never);
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(String(pg.query.mock.calls[1]?.[0])).not.toContain("CREATE TABLE");
  });
});
