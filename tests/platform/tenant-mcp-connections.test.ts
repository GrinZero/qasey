import type { MCPClient, MCPClientOptions } from "@mastra/mcp";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, QaseyMcpCatalog } from "../../packages/adapters/src/index.ts";
import { InMemoryExternalConnectionStore } from "../../src/platform/connections/connection-store.ts";
import { TenantMcpConnectionResolver } from "../../src/platform/mcp/tenant-connections.ts";

const keyring = {
  activeKeyId: "default",
  keys: { default: "tenant-mcp-credential-key-at-least-32-bytes" },
};
const subject = (tenantId: string) => ({ applicationId: "qasey", tenantId, subjectId: "user-1" });

describe("tenant-owned MCP connections", () => {
  it("resolves only active connections owned by the requested tenant", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    await createConnection(store, "tenant-a", "a-token");
    await createConnection(store, "tenant-b", "b-token");
    const resolver = new TenantMcpConnectionResolver(store);

    const tenantA = await resolver.resolve("tenant-a", []);
    expect(Object.keys(tenantA.servers)).toEqual(["figma"]);
    expect(tenantA.servers.figma).toMatchObject({
      url: "https://mcp-a.example.com/mcp",
      allowedHosts: ["mcp-a.example.com"],
      bearerToken: "a-token",
    });
    expect(JSON.stringify(await store.list("tenant-a", "mcp"))).not.toContain("a-token");
    await expect(resolver.resolve("tenant-c", [])).resolves.toMatchObject({ servers: {} });
  });

  it("rejects insecure, secret-bearing, ambiguous, and colliding public configuration", async () => {
    const insecure = new InMemoryExternalConnectionStore(keyring);
    await createConnection(insecure, "tenant-a", "token", { url: "http://mcp.example.com/mcp" });
    await expect(new TenantMcpConnectionResolver(insecure).resolve("tenant-a", []))
      .rejects.toThrow(/HTTPS/u);

    for (const url of ["https://localhost/mcp", "https://127.0.0.1/mcp", "https://metadata.local/mcp"]) {
      const privateEndpoint = new InMemoryExternalConnectionStore(keyring);
      await createConnection(privateEndpoint, "tenant-a", "token", { url });
      await expect(new TenantMcpConnectionResolver(privateEndpoint).resolve("tenant-a", []))
        .rejects.toThrow(/public DNS hostname/u);
    }

    const extra = new InMemoryExternalConnectionStore(keyring);
    await createConnection(extra, "tenant-a", "token", { configurationExtra: { headers: { value: "public" } } });
    await expect(new TenantMcpConnectionResolver(extra).resolve("tenant-a", []))
      .rejects.toThrow(/public configuration/u);

    const badCredentials = new InMemoryExternalConnectionStore(keyring);
    await createConnection(badCredentials, "tenant-a", "token", { credentialExtra: { audience: "unexpected" } });
    await expect(new TenantMcpConnectionResolver(badCredentials).resolve("tenant-a", []))
      .rejects.toThrow(/encrypted credentials/u);

    const duplicate = new InMemoryExternalConnectionStore(keyring);
    await createConnection(duplicate, "tenant-a", "one", { name: "first" });
    await createConnection(duplicate, "tenant-a", "two", { name: "second" });
    await expect(new TenantMcpConnectionResolver(duplicate).resolve("tenant-a", []))
      .rejects.toThrow(/duplicate serverName/u);
    await expect(new TenantMcpConnectionResolver(duplicate).resolve("tenant-a", ["figma"]))
      .rejects.toThrow(/collides/u);
  });

  it("caches per tenant and disconnects immediately after revision or fingerprint changes", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    const connectionA = await createConnection(store, "tenant-a", "a-token");
    await createConnection(store, "tenant-b", "b-token");
    const created: Array<{ options: MCPClientOptions; disconnect: ReturnType<typeof vi.fn> }> = [];
    const createClient = vi.fn((options: MCPClientOptions) => {
      const disconnect = vi.fn(async () => undefined);
      created.push({ options, disconnect });
      return {
        disconnect,
        listToolsWithErrors: vi.fn(async () => ({
          tools: Object.fromEntries(Object.keys(options.servers).map(serverName => [
            `${serverName}_figma_list_pages`,
            { id: `${serverName}_figma_list_pages`, execute: async () => ({ ok: true }) },
          ])),
          errors: {},
        })),
      } as unknown as MCPClient;
    });
    const catalog = new QaseyMcpCatalog(loadConfig({
      NODE_ENV: "test",
      QASEY_TENANCY_MODE: "multi",
      QASEY_MCP_CONFIG_FILE: "/path/that/does/not/exist.json",
    } as NodeJS.ProcessEnv), { connectionStore: store, createClient });

    try {
      await expect(catalog.toolsForDiscovery("api")).resolves.toEqual({});
      const toolsA = await catalog.toolsForDiscovery("api", subject("tenant-a"));
      await catalog.toolsForDiscovery("api", subject("tenant-a"));
      const toolsB = await catalog.toolsForDiscovery("api", subject("tenant-b"));
      expect(Object.keys(toolsA)).toEqual(["figma_figma_list_pages"]);
      expect(Object.keys(toolsB)).toEqual(["figma_figma_list_pages"]);
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(bearer(created[0]!.options)).toBe("Bearer a-token");
      expect(bearer(created[1]!.options)).toBe("Bearer b-token");

      await store.update({
        tenantId: "tenant-a",
        id: connectionA.id,
        expectedRevision: connectionA.revision,
        credentials: { bearerToken: "a-token-rotated" },
        actorId: "admin-a",
      });
      await catalog.toolsForDiscovery("api", subject("tenant-a"));
      expect(createClient).toHaveBeenCalledTimes(3);
      expect(created[0]!.disconnect).toHaveBeenCalledOnce();
      expect(bearer(created[2]!.options)).toBe("Bearer a-token-rotated");
    } finally {
      await catalog.close();
    }
  });
});

async function createConnection(
  store: InMemoryExternalConnectionStore,
  tenantId: string,
  bearerToken: string,
  options: {
    name?: string;
    url?: string;
    configurationExtra?: Record<string, unknown>;
    credentialExtra?: Record<string, string>;
  } = {},
) {
  return store.create({
    tenantId,
    provider: "mcp",
    name: options.name ?? "figma",
    configuration: {
      serverName: "figma",
      url: options.url ?? `https://mcp-${tenantId.endsWith("a") ? "a" : "b"}.example.com/mcp`,
      allowedHosts: [`mcp-${tenantId.endsWith("a") ? "a" : "b"}.example.com`],
      timeoutMs: 30_000,
      ...options.configurationExtra,
    },
    credentials: { bearerToken, ...options.credentialExtra },
    actorId: `admin-${tenantId}`,
  });
}

function bearer(options: MCPClientOptions): string | null {
  const server = options.servers.figma;
  if (!server || !("requestInit" in server)) return null;
  return new Headers(server.requestInit?.headers).get("authorization");
}
