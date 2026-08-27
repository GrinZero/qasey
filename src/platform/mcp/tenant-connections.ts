import { createHash } from "node:crypto";
import { z } from "zod";
import { McpServerNameSchema, type McpServerName } from "../../../packages/adapters/src/mcp-config.ts";
import type {
  ExternalConnection,
  ExternalConnectionStore,
  RuntimeExternalConnection,
} from "../connections/connection-store.ts";
import { assertPublicHostname, publicHttpsEndpoint } from "../http/public-endpoint-policy.ts";

const TenantMcpPublicConfigurationSchema = z.object({
  serverName: McpServerNameSchema,
  url: z.url(),
  allowedHosts: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(10 * 60_000).optional(),
}).strict();

const TenantMcpCredentialsSchema = z.object({
  bearerToken: z.string().min(1).max(8_192).refine(
    token => /^[\x21-\x7e]+$/u.test(token),
    "bearer token must contain visible ASCII characters only",
  ),
}).strict();

export interface TenantMcpServer {
  serverName: McpServerName;
  url: string;
  allowedHosts: string[];
  timeoutMs?: number;
  bearerToken: string;
}

export interface TenantMcpConnectionSnapshot {
  /** Hash of public revision/fingerprint metadata. Never includes credentials. */
  version: string;
  servers: Partial<Record<McpServerName, TenantMcpServer>>;
}

/** Resolves only active, tenant-owned MCP credentials from encrypted storage. */
export class TenantMcpConnectionResolver {
  constructor(private readonly store: ExternalConnectionStore) {}

  async resolve(
    tenantId: string,
    staticServerNames: readonly McpServerName[],
  ): Promise<TenantMcpConnectionSnapshot> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) throw new Error("MCP tenant must be non-empty");

    // list/getRuntime are deliberately checked twice. A credential rotation or
    // disable between the public read and decrypt must not produce a stale client.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.store.list(normalizedTenantId, "mcp");
      const result = await this.resolveSnapshot(normalizedTenantId, before, staticServerNames);
      const after = await this.store.list(normalizedTenantId, "mcp");
      if (connectionManifest(before) === connectionManifest(after)) return result;
    }
    throw new Error("Tenant MCP connections changed while being resolved; retry the request");
  }

  private async resolveSnapshot(
    tenantId: string,
    connections: readonly ExternalConnection[],
    staticServerNames: readonly McpServerName[],
  ): Promise<TenantMcpConnectionSnapshot> {
    const staticNames = new Set(staticServerNames);
    const servers: Partial<Record<McpServerName, TenantMcpServer>> = {};
    const active = connections.filter(connection => connection.status === "active");

    for (const connection of active) {
      const publicConfiguration = parsePublicConfiguration(connection);
      if (staticNames.has(publicConfiguration.serverName)) {
        throw new Error(`Tenant MCP serverName ${publicConfiguration.serverName} collides with static configuration`);
      }
      if (servers[publicConfiguration.serverName]) {
        throw new Error(`Tenant MCP connections contain duplicate serverName ${publicConfiguration.serverName}`);
      }

      const runtime = await this.store.getRuntime(tenantId, connection.id);
      if (!sameConnectionRevision(connection, runtime)) {
        throw new Error("Tenant MCP connection changed while credentials were being resolved; retry the request");
      }
      const credentials = parseCredentials(runtime);
      const endpoint = validateEndpoint(publicConfiguration.url);
      const allowedHosts = validateAllowedHosts(publicConfiguration.allowedHosts, endpoint);
      servers[publicConfiguration.serverName] = {
        serverName: publicConfiguration.serverName,
        url: endpoint.toString(),
        allowedHosts,
        ...(publicConfiguration.timeoutMs === undefined ? {} : { timeoutMs: publicConfiguration.timeoutMs }),
        bearerToken: credentials.bearerToken,
      };
    }

    return {
      version: createHash("sha256").update(connectionManifest(connections)).digest("hex"),
      servers,
    };
  }
}

function parsePublicConfiguration(connection: ExternalConnection) {
  const parsed = TenantMcpPublicConfigurationSchema.safeParse(connection.configuration);
  if (!parsed.success) {
    throw new Error(`Tenant MCP ${connection.name} has invalid public configuration`);
  }
  return parsed.data;
}

function parseCredentials(connection: RuntimeExternalConnection) {
  const parsed = TenantMcpCredentialsSchema.safeParse(connection.credentials);
  if (!parsed.success) {
    throw new Error(`Tenant MCP ${connection.name} has invalid encrypted credentials`);
  }
  return parsed.data;
}

function validateEndpoint(value: string): URL {
  return publicHttpsEndpoint(value, "Tenant MCP endpoint");
}

function validateAllowedHosts(values: readonly string[], endpoint: URL): string[] {
  const allowedHosts = values.map(value => {
    if (value !== value.trim() || value.includes("://") || /[/?#@*]/u.test(value)) {
      throw new Error("Tenant MCP allowedHosts must contain exact host values without wildcards");
    }
    let parsed: URL;
    try {
      parsed = new URL(`https://${value}`);
    } catch {
      throw new Error("Tenant MCP allowedHosts contains an invalid host");
    }
    if (parsed.host.toLowerCase() !== value.toLowerCase() || parsed.pathname !== "/") {
      throw new Error("Tenant MCP allowedHosts contains an invalid host");
    }
    assertPublicHostname(parsed.hostname, "Tenant MCP allowedHosts");
    return parsed.host;
  });
  if (new Set(allowedHosts.map(host => host.toLowerCase())).size !== allowedHosts.length) {
    throw new Error("Tenant MCP allowedHosts must not contain duplicates");
  }
  if (!allowedHosts.some(host => host.toLowerCase() === endpoint.host.toLowerCase())) {
    throw new Error("Tenant MCP allowedHosts must include the endpoint host");
  }
  return allowedHosts;
}

function sameConnectionRevision(
  publicConnection: ExternalConnection,
  runtimeConnection: RuntimeExternalConnection | undefined,
): runtimeConnection is RuntimeExternalConnection {
  return Boolean(
    runtimeConnection
    && runtimeConnection.status === "active"
    && runtimeConnection.revision === publicConnection.revision
    && runtimeConnection.credentialFingerprint === publicConnection.credentialFingerprint,
  );
}

function connectionManifest(connections: readonly ExternalConnection[]): string {
  return JSON.stringify([...connections]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(connection => ({
      id: connection.id,
      status: connection.status,
      revision: connection.revision,
      credentialFingerprint: connection.credentialFingerprint,
    })));
}
