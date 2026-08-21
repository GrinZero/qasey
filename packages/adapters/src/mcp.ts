import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { MCPClient, MCPOAuthClientProvider } from "@mastra/mcp";
import type { MastraMCPServerDefinition, OAuthStorage } from "@mastra/mcp";
import type { ToolsInput } from "@mastra/core/agent";
import type { QaseyChannel } from "../../contracts/src/index.ts";
import { authorizeDiscoveredToolAccess, TOOL_POLICIES } from "../../domain/src/index.ts";
import type { QaseyConfig } from "./config.ts";
import { logError, logInfo } from "./logging.ts";
import { loadMcpServerConfigs, type McpServerConfig, type McpServerConfigs, type McpServerName } from "./mcp-config.ts";
import { FileOAuthStorage, PostgresOAuthStorage, PostgresOAuthStorageBackend } from "./oauth-storage.ts";
import { SubjectMcpClientPool } from "../../../src/platform/mcp/create-clients.ts";

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

/** Static upper bound used by safe experiment validation; does not contact MCP servers. */
export const QASEY_MCP_ALLOWED_TOOL_NAMES = Object.entries(allowedTools).flatMap(([server, tools]) =>
  [...tools].map(tool => `${server}_${tool}`),
);

const defaultTimeouts: Record<McpServerName, number> = {
  metersphere: 60_000,
  figma: 120_000,
  qaExperience: 60_000,
  rag: 180_000,
  lark: 60_000,
};

const TOOL_DISCOVERY_TTL_MS = 15 * 60_000;
const FAILED_TOOL_DISCOVERY_TTL_MS = 30_000;
const INITIAL_TOOL_DISCOVERY_BUDGET_MS = 5_000;

type ToolDiscoveryResult = Awaited<ReturnType<MCPClient["listToolsWithErrors"]>>;
type ToolDiscoveryClient = Pick<MCPClient, "listToolsWithErrors">;

interface ToolDiscoveryCacheEntry {
  expiresAt: number;
  value?: ToolDiscoveryResult;
  refresh?: Promise<ToolDiscoveryResult>;
}

export interface McpToolDiscoveryCacheOptions {
  successTtlMs?: number;
  failureTtlMs?: number;
  initialWaitMs?: number;
  now?: () => number;
}

/** Bounded first load plus stale-while-revalidate for remote MCP metadata. */
export class McpToolDiscoveryCache {
  private readonly entries = new WeakMap<object, ToolDiscoveryCacheEntry>();
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly initialWaitMs: number;
  private readonly now: () => number;

  constructor(options: McpToolDiscoveryCacheOptions = {}) {
    this.successTtlMs = options.successTtlMs ?? TOOL_DISCOVERY_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? FAILED_TOOL_DISCOVERY_TTL_MS;
    this.initialWaitMs = options.initialWaitMs ?? INITIAL_TOOL_DISCOVERY_BUDGET_MS;
    this.now = options.now ?? Date.now;
  }

  delete(client: ToolDiscoveryClient): void {
    this.entries.delete(client);
  }

  async get(client: ToolDiscoveryClient): Promise<ToolDiscoveryResult> {
    const now = this.now();
    const entry = this.entries.get(client) ?? { expiresAt: 0 };
    this.entries.set(client, entry);
    if (entry.value && entry.expiresAt > now) {
      logInfo("mcp.tools.discovery", { cacheHit: true, stale: false });
      return entry.value;
    }

    const refresh = entry.refresh ?? this.refresh(client, entry);
    if (entry.value) {
      logInfo("mcp.tools.discovery", { cacheHit: true, stale: true });
      return entry.value;
    }
    return this.waitForInitialDiscovery(refresh, entry);
  }

  private refresh(client: ToolDiscoveryClient, entry: ToolDiscoveryCacheEntry): Promise<ToolDiscoveryResult> {
    const startedAt = this.now();
    const refresh = Promise.resolve()
      .then(() => client.listToolsWithErrors())
      .catch((error: unknown): ToolDiscoveryResult => ({
        tools: {},
        errors: { discovery: error instanceof Error ? error.message : String(error) },
      }))
      .then(result => {
        entry.value = result;
        entry.expiresAt = this.now() + (Object.keys(result.errors).length > 0 ? this.failureTtlMs : this.successTtlMs);
        logInfo("mcp.tools.discovery", {
          cacheHit: false,
          durationMs: this.now() - startedAt,
          toolCount: Object.keys(result.tools).length,
          errorCount: Object.keys(result.errors).length,
        });
        return result;
      })
      .finally(() => { delete entry.refresh; });
    entry.refresh = refresh;
    return refresh;
  }

  private async waitForInitialDiscovery(
    refresh: Promise<ToolDiscoveryResult>,
    entry: ToolDiscoveryCacheEntry,
  ): Promise<ToolDiscoveryResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<ToolDiscoveryResult>(resolve => {
      timeout = setTimeout(() => {
        const result: ToolDiscoveryResult = {
          tools: {},
          errors: { discovery: "Tool discovery is still warming in the background" },
        };
        entry.value = result;
        entry.expiresAt = this.now() + this.failureTtlMs;
        resolve(result);
      }, this.initialWaitMs);
    });
    try {
      return await Promise.race([refresh, fallback]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function storageFor(
  config: QaseyConfig,
  serverName: McpServerName,
  subjectKey: string,
  postgresBackend?: PostgresOAuthStorageBackend,
): OAuthStorage {
  const namespace = `qasey:${subjectKey}:${serverName}`;
  if (config.DATABASE_URL && config.MASTRA_ENCRYPTION_KEY) {
    if (!postgresBackend) throw new Error("Postgres OAuth storage backend has not been configured");
    return new PostgresOAuthStorage(postgresBackend, config.MASTRA_ENCRYPTION_KEY, namespace);
  }
  if (config.NODE_ENV === "production") {
    throw new Error(`OAuth MCP ${serverName} requires DATABASE_URL and MASTRA_ENCRYPTION_KEY in production`);
  }
  const digest = createHash("sha256").update(namespace).digest("hex");
  return new FileOAuthStorage(resolve(config.QASEY_MCP_OAUTH_DIR, `${digest}.json`));
}

function serverDefinition(
  name: McpServerName,
  spec: McpServerConfig,
  config: QaseyConfig,
  subjectKey?: string,
  onAuthorizationUrl?: (server: McpServerName, url: URL) => void | Promise<void>,
  postgresBackend?: PostgresOAuthStorageBackend,
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

  if (!subjectKey) throw new Error(`OAuth MCP ${name} requires a credential subject`);
  const clientId = spec.auth.clientIdEnv ? process.env[spec.auth.clientIdEnv] : undefined;
  const clientSecret = spec.auth.clientSecretEnv ? process.env[spec.auth.clientSecretEnv] : undefined;
  if (spec.auth.clientIdEnv && !clientId) throw new Error(`MCP ${name} expects OAuth client ID in ${spec.auth.clientIdEnv}`);
  if (spec.auth.clientSecretEnv && !clientSecret) throw new Error(`MCP ${name} expects OAuth client secret in ${spec.auth.clientSecretEnv}`);
  const storage = storageFor(config, name, subjectKey, postgresBackend);
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
    storage,
    ...(onAuthorizationUrl ? { onRedirectToAuthorization: url => onAuthorizationUrl(name, url) } : {}),
  });
  return { ...common, authProvider };
}

export interface QaseyMcpCatalogOptions {
  onAuthorizationUrl?: (server: McpServerName, url: URL) => void | Promise<void>;
}

export interface McpCredentialSubject {
  applicationId: string;
  tenantId: string;
  subjectId: string;
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
  private sharedClient?: MCPClient;
  private readonly subjectClients: SubjectMcpClientPool;
  private readonly toolDiscovery = new McpToolDiscoveryCache();
  private readonly oauthBackend: PostgresOAuthStorageBackend | undefined;
  private readonly servers: McpServerConfigs;

  constructor(private readonly config: QaseyConfig, private readonly options: QaseyMcpCatalogOptions = {}) {
    this.servers = loadMcpServerConfigs(config);
    this.oauthBackend = config.DATABASE_URL && config.MASTRA_ENCRYPTION_KEY && this.oauthServerNames().length > 0
      ? new PostgresOAuthStorageBackend(config.DATABASE_URL)
      : undefined;
    this.subjectClients = new SubjectMcpClientPool(subjectKey => new MCPClient({
      id: `qasey-oauth-${createHash("sha256").update(subjectKey).digest("hex").slice(0, 16)}`,
      servers: Object.fromEntries(this.oauthServerNames().map(name => [
        name, serverDefinition(
          name,
          this.servers[name]!,
          this.config,
          subjectKey,
          this.options.onAuthorizationUrl,
          this.oauthBackend,
        ),
      ])),
    }), 64, 15 * 60_000);
  }

  configuredServers(): McpServerName[] {
    return Object.keys(this.servers) as McpServerName[];
  }

  async init(): Promise<void> {
    await this.oauthBackend?.init();
  }

  async healthCheck(): Promise<void> {
    await this.oauthBackend?.healthCheck();
  }

  private oauthServerNames(): McpServerName[] {
    return this.configuredServers().filter(name => this.servers[name]!.auth.type === "oauth");
  }

  private getSharedClient(): MCPClient | undefined {
    if (this.sharedClient) return this.sharedClient;
    const configured = Object.fromEntries(this.configuredServers().filter(name => this.servers[name]!.auth.type !== "oauth").map(name => [
      name,
      serverDefinition(name, this.servers[name]!, this.config),
    ]));
    if (Object.keys(configured).length === 0) return undefined;
    this.sharedClient = new MCPClient({ id: "qasey-shared-service-mcp", servers: configured });
    return this.sharedClient;
  }

  async authenticate(serverName: McpServerName, subject: McpCredentialSubject): Promise<void> {
    const spec = this.servers[serverName];
    if (!spec) throw new Error(`MCP server is not configured: ${serverName}`);
    if (spec.auth.type !== "oauth") throw new Error(`MCP server ${serverName} does not use OAuth`);
    const client = await this.subjectClients.get(subjectKey(subject));
    await client.authenticate(serverName);
    this.toolDiscovery.delete(client);
  }

  /**
   * Caller-bound catalog for qasey-main Tool Discovery. Semantic intent does
   * not prune this catalog. Real case mutation is still blocked by the Agent
   * wrapper and owned by the deterministic MeterSphere workflow.
   */
  async toolsForDiscovery(
    channel: QaseyChannel,
    subject?: McpCredentialSubject,
    options: { readOnly?: boolean } = {},
  ): Promise<ToolsInput> {
    const tools = await this.discoveredTools(subject);
    return this.selectTools(tools, channel, {
      canWriteCases: !options.readOnly,
      canWriteExperience: !options.readOnly && channel === "slack",
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    });
  }

  /** Write-capable tools are exposed only inside the owned case Workflow. */
  async toolsForCaseWorkflow(channel: QaseyChannel, subject?: McpCredentialSubject): Promise<ToolsInput> {
    const tools = await this.discoveredTools(subject);
    return this.selectTools(tools, channel, {
      canWriteCases: true,
      canWriteExperience: false,
    });
  }

  private async discoveredTools(subject?: McpCredentialSubject): Promise<ToolsInput> {
    const clients: MCPClient[] = [];
    const shared = this.getSharedClient();
    if (shared) clients.push(shared);
    if (subject && this.oauthServerNames().length > 0) clients.push(await this.subjectClients.get(subjectKey(subject)));
    if (clients.length === 0) return {};
    const discovered = await Promise.all(clients.map(client => this.discoverTools(client)));
    const tools = Object.assign({}, ...discovered.map(result => result.tools)) as ToolsInput;
    for (const result of discovered) for (const [server, message] of Object.entries(result.errors)) {
      logError("mcp.tools.discovery_failed", new Error(message), { server, subjectBound: Boolean(subject) });
    }
    return tools;
  }

  private selectTools(
    tools: ToolsInput,
    channel: QaseyChannel,
    access: {
      canWriteCases: boolean;
      canWriteExperience: boolean;
      readOnly?: boolean;
    },
  ): ToolsInput {
    const selected = Object.entries(tools).filter(([qualified]) => {
      const [server = "", ...parts] = qualified.split("_");
      const tool = parts.join("_");
      const allowlist = allowedTools[server as keyof typeof allowedTools];
      if (!allowlist?.has(tool as never)) return false;
      if (server === "metersphere" && /create|edit|upsert|delete/.test(tool)) return access.canWriteCases && !tool.includes("delete");
      if (server === "qaExperience" && tool === "qa_experience_upsert") return access.canWriteExperience;
      return true;
    });
    const output: ToolsInput = {};
    for (const [qualified, tool] of selected) {
      const [server = "", ...parts] = qualified.split("_");
      const name = parts.join("_");
      const policyId = server === "metersphere"
        ? (/create|edit|upsert|delete/.test(name) ? "metersphere_write" : "metersphere_read")
        : server === "qaExperience" && name === "qa_experience_upsert"
          ? "qa_experience_write"
          : "external_read";
      const policy = TOOL_POLICIES[policyId]!;
      if (access.readOnly && policy.effect !== "read") continue;
      const execute = "execute" in tool ? tool.execute : undefined;
      output[qualified] = {
        ...tool,
        requireApproval: policy.requiresApproval,
        execute: async (input: unknown, executionContext: Parameters<NonNullable<typeof execute>>[1]) => {
          authorizeDiscoveredToolAccess(qualified, policy, { channel });
          if (server === "figma") validateFigmaToolInput(qualified, input);
          if (!execute) throw new Error(`MCP tool ${qualified} has no executor`);
          return execute(input as never, executionContext);
        },
      } as ToolsInput[string];
    }
    return output;
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.sharedClient?.disconnect() ?? Promise.resolve(),
      this.subjectClients.close(),
      this.oauthBackend?.close() ?? Promise.resolve(),
    ]);
  }

  private async discoverTools(client: MCPClient): Promise<ToolDiscoveryResult> {
    return this.toolDiscovery.get(client);
  }
}

function subjectKey(subject: McpCredentialSubject): string {
  const values = [subject.applicationId, subject.tenantId, subject.subjectId].map(value => value.trim());
  if (values.some(value => !value)) throw new Error("MCP credential subject fields must be non-empty");
  return values.map(value => encodeURIComponent(value)).join(":");
}
