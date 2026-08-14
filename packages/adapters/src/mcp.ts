import { resolve } from "node:path";
import { MCPClient, MCPOAuthClientProvider } from "@mastra/mcp";
import type { MastraMCPServerDefinition, OAuthStorage } from "@mastra/mcp";
import type { ToolsInput } from "@mastra/core/agent";
import type { IntentRoute, QaseyChannel } from "../../contracts/src/index.ts";
import { authorizeToolAccess, TOOL_POLICIES } from "../../domain/src/index.ts";
import type { QaseyConfig } from "./config.ts";
import { logError } from "./logging.ts";
import { loadMcpServerConfigs, type McpServerConfig, type McpServerConfigs, type McpServerName } from "./mcp-config.ts";
import { FileOAuthStorage, PostgresOAuthStorage } from "./oauth-storage.ts";

const allowedTools = {
  metersphere: new Set([
    "ms_bulk_upsert_test_cases", "ms_list_modules", "ms_get_test_case_detail", "ms_create_test_case",
    "ms_batch_edit_test_cases", "ms_list_test_cases", "ms_edit_test_case", "ms_upsert_module",
  ]),
  figma: new Set(["figma_get_comments", "figma_get_components", "figma_export_image", "figma_get_node_detail", "figma_get_page_structure", "figma_list_pages"]),
  qaExperience: new Set(["qa_context_get", "qa_experience_list", "qa_experience_read", "qa_experience_upsert"]),
  rag: new Set(["answer"]),
  lark: new Set(["lark_doc_search", "lark_doc_read"]),
} as const;

const defaultTimeouts: Record<McpServerName, number> = {
  metersphere: 60_000,
  figma: 120_000,
  qaExperience: 60_000,
  rag: 180_000,
  lark: 60_000,
};

function storageFor(config: QaseyConfig, serverName: McpServerName): OAuthStorage {
  if (config.DATABASE_URL && config.MASTRA_ENCRYPTION_KEY) {
    return new PostgresOAuthStorage(config.DATABASE_URL, config.MASTRA_ENCRYPTION_KEY, serverName);
  }
  if (config.NODE_ENV === "production") {
    throw new Error(`OAuth MCP ${serverName} requires DATABASE_URL and MASTRA_ENCRYPTION_KEY in production`);
  }
  return new FileOAuthStorage(resolve(config.QASEY_MCP_OAUTH_DIR, `${serverName}.json`));
}

function serverDefinition(
  name: McpServerName,
  spec: McpServerConfig,
  config: QaseyConfig,
  onAuthorizationUrl?: (server: McpServerName, url: URL) => void | Promise<void>,
): MastraMCPServerDefinition {
  const endpoint = new URL(spec.url);
  const allowedHosts = [...new Set([endpoint.host, ...spec.allowedHosts])];
  const common = {
    url: endpoint,
    allowedHosts,
    timeout: spec.timeoutMs ?? defaultTimeouts[name],
    forwardInstructions: false,
  } satisfies Pick<MastraMCPServerDefinition, "url" | "allowedHosts" | "timeout" | "forwardInstructions">;

  if (spec.auth.type === "none") return common;
  if (spec.auth.type === "bearer") {
    const token = process.env[spec.auth.tokenEnv];
    if (!token) throw new Error(`MCP ${name} expects bearer credential in ${spec.auth.tokenEnv}`);
    const headers = { Authorization: `Bearer ${token}` };
    return {
      ...common,
      requestInit: { headers },
      eventSourceInit: {
        fetch: (url: string | URL, init?: RequestInit) => fetch(url, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers },
        }),
      },
    };
  }

  const clientId = spec.auth.clientIdEnv ? process.env[spec.auth.clientIdEnv] : undefined;
  const clientSecret = spec.auth.clientSecretEnv ? process.env[spec.auth.clientSecretEnv] : undefined;
  if (spec.auth.clientIdEnv && !clientId) throw new Error(`MCP ${name} expects OAuth client ID in ${spec.auth.clientIdEnv}`);
  if (spec.auth.clientSecretEnv && !clientSecret) throw new Error(`MCP ${name} expects OAuth client secret in ${spec.auth.clientSecretEnv}`);
  const authProvider = new MCPOAuthClientProvider({
    redirectUrl: spec.auth.redirectUrl,
    clientMetadata: {
      redirect_uris: [spec.auth.redirectUrl],
      client_name: `Qasey (${name})`,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: clientSecret ? "client_secret_post" : "none",
      ...(spec.auth.scopes ? { scope: spec.auth.scopes.join(" ") } : {}),
    },
    ...(clientId ? { clientInformation: { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) } } : {}),
    storage: storageFor(config, name),
    ...(onAuthorizationUrl ? { onRedirectToAuthorization: url => onAuthorizationUrl(name, url) } : {}),
  });
  return { ...common, authProvider };
}

export interface QaseyMcpCatalogOptions {
  onAuthorizationUrl?: (server: McpServerName, url: URL) => void | Promise<void>;
}

export class InvalidToolInputError extends Error {
  readonly code = "INVALID_ARGUMENT";
  readonly statusCode = 400;

  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "InvalidToolInputError";
  }
}

export function validateFigmaToolInput(toolName: string, input: unknown): void {
  if (!toolName.toLowerCase().includes("figma") || !input || typeof input !== "object") return;
  const value = input as Record<string, unknown>;
  const fileKey = value.file_key ?? value.fileKey;
  if (fileKey === undefined) return;
  if (typeof fileKey !== "string" || fileKey.trim().length === 0) {
    throw new InvalidToolInputError("file_key", "Figma file_key must be a non-empty file key extracted from the Figma URL");
  }
  const trimmed = fileKey.trim();
  if (/^\d+[:-]\d+$/.test(trimmed)) {
    throw new InvalidToolInputError("file_key", `Figma file_key received a node id (${trimmed}); pass it through node_ids instead`);
  }
  if (/\s/.test(trimmed)) {
    throw new InvalidToolInputError("file_key", "Figma file_key received a title or name; pass the key from /design/<file_key>/ in the Figma URL");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new InvalidToolInputError("file_key", "Figma file_key received a full URL; extract the segment after /design/ and pass node-id separately");
  }
}

export class QaseyMcpCatalog {
  private client?: MCPClient;
  private readonly servers: McpServerConfigs;

  constructor(private readonly config: QaseyConfig, private readonly options: QaseyMcpCatalogOptions = {}) {
    this.servers = loadMcpServerConfigs(config);
  }

  configuredServers(): McpServerName[] {
    return Object.keys(this.servers) as McpServerName[];
  }

  private getClient(): MCPClient | undefined {
    if (this.client) return this.client;
    const configured = Object.fromEntries(this.configuredServers().map(name => [
      name,
      serverDefinition(name, this.servers[name]!, this.config, this.options.onAuthorizationUrl),
    ]));
    if (Object.keys(configured).length === 0) return undefined;
    this.client = new MCPClient({ id: "qasey-mcp-catalog", servers: configured });
    return this.client;
  }

  async authenticate(serverName: McpServerName): Promise<void> {
    const spec = this.servers[serverName];
    if (!spec) throw new Error(`MCP server is not configured: ${serverName}`);
    if (spec.auth.type !== "oauth") throw new Error(`MCP server ${serverName} does not use OAuth`);
    await this.getClient()!.authenticate(serverName);
  }

  async toolsFor(route: IntentRoute, channel: QaseyChannel): Promise<ToolsInput> {
    const client = this.getClient();
    if (!client) return {};
    const { tools, errors } = await client.listToolsWithErrors();
    for (const [server, message] of Object.entries(errors)) {
      logError("mcp.tools.discovery_failed", new Error(message), { server });
    }
    const canWriteCases = route.intent === "case_create_full" || route.intent === "case_maintain_fast";
    const canWriteExperience = route.intent === "experience_write" && channel === "slack";
    const selected = Object.entries(tools).filter(([qualified]) => {
      const [server = "", ...parts] = qualified.split("_");
      const tool = parts.join("_");
      const allowlist = allowedTools[server as keyof typeof allowedTools];
      if (!allowlist?.has(tool as never)) return false;
      if (server === "metersphere" && /create|edit|upsert|delete/.test(tool)) return canWriteCases && !tool.includes("delete");
      if (server === "qaExperience" && tool === "qa_experience_upsert") return canWriteExperience;
      return true;
    });
    return Object.fromEntries(selected.map(([qualified, tool]) => {
      const [server = "", ...parts] = qualified.split("_");
      const name = parts.join("_");
      const policyId = server === "metersphere"
        ? (/create|edit|upsert|delete/.test(name) ? "metersphere_write" : "metersphere_read")
        : server === "qaExperience" && name === "qa_experience_upsert"
          ? "qa_experience_write"
          : "external_read";
      const policy = TOOL_POLICIES[policyId]!;
      const execute = tool.execute;
      return [qualified, {
        ...tool,
        requireApproval: policy.requiresApproval,
        execute: async (input: unknown, executionContext: Parameters<NonNullable<typeof execute>>[1]) => {
          authorizeToolAccess(qualified, policy, { channel, route });
          if (server === "figma") validateFigmaToolInput(qualified, input);
          if (!execute) throw new Error(`MCP tool ${qualified} has no executor`);
          return execute(input as never, executionContext);
        },
      }];
    }));
  }

  async close(): Promise<void> {
    await this.client?.disconnect();
  }
}
