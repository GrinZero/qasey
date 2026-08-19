import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({
  construct: vi.fn(),
  query: vi.fn(async (sql: unknown) => ({
    rows: String(sql).startsWith("SELECT encrypted_value") ? [{ encrypted_value: undefined }] : [],
    rowCount: 1,
  })),
  end: vi.fn(async () => undefined),
}));

vi.mock("pg", () => ({
  Pool: class {
    constructor() { pg.construct(); }
    query = pg.query;
    end = pg.end;
  },
}));

import { PostgresOAuthStorage, PostgresOAuthStorageBackend } from "../../packages/adapters/src/oauth-storage.ts";

describe("Postgres OAuth storage", () => {
  beforeEach(() => {
    pg.construct.mockClear();
    pg.query.mockClear();
    pg.end.mockClear();
  });

  it("shares one initialized pool across subject namespaces", async () => {
    const backend = new PostgresOAuthStorageBackend("postgres://example");
    const first = new PostgresOAuthStorage(backend, "0123456789abcdef0123456789abcdef", "qasey:first:figma");
    const second = new PostgresOAuthStorage(backend, "0123456789abcdef0123456789abcdef", "qasey:second:figma");

    await expect(first.set("tokens", "secret")).rejects.toThrow("has not been initialized");
    expect(pg.query).not.toHaveBeenCalled();

    await backend.init();
    await first.set("tokens", "secret-1");
    await second.set("tokens", "secret-2");

    expect(pg.construct).toHaveBeenCalledOnce();
    expect(pg.query.mock.calls.filter(([sql]) => String(sql).includes("CREATE TABLE"))).toHaveLength(1);
    expect(pg.query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO"))).toHaveLength(2);

    await backend.close();
    expect(pg.end).toHaveBeenCalledOnce();
  });
});
