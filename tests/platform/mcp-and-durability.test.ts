import type { MCPClient } from "@mastra/mcp";
import { describe, expect, it, vi } from "vitest";
import { SubjectMcpClientPool, VersionedMcpClientPool } from "../../src/platform/mcp/create-clients.ts";
import { assertJsonSafeSnapshot, externalWriteIdempotencyKey } from "../../src/platform/workflows/durability.ts";

describe("subject MCP lifecycle", () => {
  it("deduplicates concurrent creation, evicts LRU clients, and disconnects on shutdown", async () => {
    const clients = new Map<string, { disconnect: ReturnType<typeof vi.fn> }>();
    const create = vi.fn(async (key: string) => {
      const client = { disconnect: vi.fn(async () => undefined) };
      clients.set(key, client);
      return client as unknown as MCPClient;
    });
    const pool = new SubjectMcpClientPool(create, 2, 60_000);
    const [first, duplicate] = await Promise.all([pool.get("tenant:user-1"), pool.get("tenant:user-1")]);
    expect(first).toBe(duplicate);
    expect(create).toHaveBeenCalledTimes(1);
    await pool.get("tenant:user-2");
    await pool.get("tenant:user-3");
    expect(clients.get("tenant:user-1")?.disconnect).toHaveBeenCalledOnce();
    await pool.close();
    expect(clients.get("tenant:user-2")?.disconnect).toHaveBeenCalledOnce();
    expect(clients.get("tenant:user-3")?.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects and replaces a tenant client when its connection version changes", async () => {
    const clients: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    const pool = new VersionedMcpClientPool(2, 60_000);
    const create = vi.fn(async () => {
      const client = { disconnect: vi.fn(async () => undefined) };
      clients.push(client);
      return client as unknown as MCPClient;
    });

    const first = await pool.get("tenant-a", "revision-1", create);
    await expect(pool.get("tenant-a", "revision-1", create)).resolves.toBe(first);
    expect(create).toHaveBeenCalledOnce();

    const second = await pool.get("tenant-a", "revision-2", create);
    expect(second).not.toBe(first);
    expect(clients[0]?.disconnect).toHaveBeenCalledOnce();
    await pool.remove("tenant-a");
    expect(clients[1]?.disconnect).toHaveBeenCalledOnce();
    await pool.close();
  });
});

describe("workflow durability contracts", () => {
  it("builds owner-scoped stable external-write keys", () => {
    expect(externalWriteIdempotencyKey({ applicationId: "qasey", tenantId: "tenant/a", workflowId: "case-write", runId: "run-1", effect: "case-hub" }))
      .toBe("qasey:tenant%2Fa:case-write:run-1:case-hub");
  });

  it("allows bounded JSON snapshots and rejects process-bound state", () => {
    expect(() => assertJsonSafeSnapshot({ runId: "run", refs: ["artifact://one"] })).not.toThrow();
    expect(() => assertJsonSafeSnapshot({ callback: () => undefined })).toThrow(/non-JSON/u);
    expect(() => assertJsonSafeSnapshot({ payload: "x".repeat(100) }, 20)).toThrow(/limit/u);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertJsonSafeSnapshot(cycle)).toThrow(/cycle/u);
  });
});
