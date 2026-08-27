import { MCPClient, type MCPClientOptions } from "@mastra/mcp";

export function createSharedMcpClient(id: string, servers: MCPClientOptions["servers"], timeout?: number): MCPClient {
  return new MCPClient({ id, servers, ...(timeout ? { timeout } : {}) });
}

/** Only OAuth/session-bound MCP servers use a subject-keyed bounded cache. */
export class SubjectMcpClientPool {
  private readonly entries = new Map<string, { client: MCPClient; touchedAt: number }>();
  private readonly pending = new Map<string, Promise<MCPClient>>();

  constructor(
    private readonly create: (subjectKey: string) => MCPClient | Promise<MCPClient>,
    private readonly capacity = 64,
    private readonly idleTtlMs = 15 * 60_000,
  ) {}

  async get(subjectKey: string): Promise<MCPClient> {
    if (!subjectKey.trim()) throw new Error("MCP credential subject must be non-empty");
    await this.evictIdle();
    const existing = this.entries.get(subjectKey);
    if (existing) { existing.touchedAt = Date.now(); return existing.client; }
    const inFlight = this.pending.get(subjectKey);
    if (inFlight) return inFlight;
    const creation = Promise.resolve(this.create(subjectKey)).then(async client => {
      this.entries.set(subjectKey, { client, touchedAt: Date.now() });
      await this.evictCapacity();
      return client;
    }).finally(() => this.pending.delete(subjectKey));
    this.pending.set(subjectKey, creation);
    return creation;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
    const clients = [...this.entries.values()].map(entry => entry.client);
    this.entries.clear();
    await Promise.allSettled(clients.map(client => client.disconnect()));
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [key, entry] of this.entries) {
      if (entry.touchedAt > cutoff) continue;
      this.entries.delete(key);
      await entry.client.disconnect();
    }
  }

  private async evictCapacity(): Promise<void> {
    while (this.entries.size > this.capacity) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      await oldest[1].client.disconnect();
    }
  }
}

interface VersionedMcpClientEntry {
  client: MCPClient;
  version: string;
  touchedAt: number;
}

interface PendingVersionedMcpClient {
  version: string;
  promise: Promise<MCPClient>;
}

/**
 * Tenant-keyed cache for clients backed by mutable external connections.
 * A changed connection version is disconnected before the replacement client
 * is created so stale bearer credentials cannot survive credential rotation.
 */
export class VersionedMcpClientPool {
  private readonly entries = new Map<string, VersionedMcpClientEntry>();
  private readonly pending = new Map<string, PendingVersionedMcpClient>();

  constructor(
    private readonly capacity = 64,
    private readonly idleTtlMs = 15 * 60_000,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("MCP client pool capacity must be a positive integer");
    if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) throw new Error("MCP client pool idle TTL must be positive");
  }

  async get(
    scopeKey: string,
    version: string,
    create: () => MCPClient | Promise<MCPClient>,
  ): Promise<MCPClient> {
    if (!scopeKey.trim()) throw new Error("MCP client scope must be non-empty");
    if (!version.trim()) throw new Error("MCP connection version must be non-empty");
    await this.evictIdle();

    const existing = this.entries.get(scopeKey);
    if (existing?.version === version) {
      existing.touchedAt = Date.now();
      return existing.client;
    }

    const inFlight = this.pending.get(scopeKey);
    if (inFlight) {
      if (inFlight.version === version) return inFlight.promise;
      await inFlight.promise;
      return this.get(scopeKey, version, create);
    }

    const creation = (async () => {
      const stale = this.entries.get(scopeKey);
      if (stale) {
        this.entries.delete(scopeKey);
        await stale.client.disconnect();
      }
      const client = await create();
      this.entries.set(scopeKey, { client, version, touchedAt: Date.now() });
      await this.evictCapacity();
      return client;
    })();
    const tracked = creation.finally(() => {
      if (this.pending.get(scopeKey)?.promise === tracked) this.pending.delete(scopeKey);
    });
    this.pending.set(scopeKey, { version, promise: tracked });
    return tracked;
  }

  async remove(scopeKey: string): Promise<void> {
    const inFlight = this.pending.get(scopeKey);
    if (inFlight) await inFlight.promise.catch(() => undefined);
    const existing = this.entries.get(scopeKey);
    if (!existing) return;
    this.entries.delete(scopeKey);
    await existing.client.disconnect();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pending.values()].map(entry => entry.promise));
    const clients = [...this.entries.values()].map(entry => entry.client);
    this.entries.clear();
    await Promise.allSettled(clients.map(client => client.disconnect()));
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [key, entry] of this.entries) {
      if (entry.touchedAt > cutoff) continue;
      this.entries.delete(key);
      await entry.client.disconnect();
    }
  }

  private async evictCapacity(): Promise<void> {
    while (this.entries.size > this.capacity) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      await oldest[1].client.disconnect();
    }
  }
}
