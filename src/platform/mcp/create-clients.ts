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

