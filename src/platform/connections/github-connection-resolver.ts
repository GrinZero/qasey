import {
  GitHubInstallationTokenProvider,
  GitHubPublisher,
  createGitHubClient,
} from "../../../packages/adapters/src/github.ts";
import type { ExternalConnectionStore, RuntimeExternalConnection } from "./connection-store.ts";

export type TenantGitHubConnectionErrorCode =
  | "github_connection_not_found"
  | "github_connection_ambiguous"
  | "github_connection_invalid";

export class TenantGitHubConnectionError extends Error {
  constructor(readonly code: TenantGitHubConnectionErrorCode) {
    super({
      github_connection_not_found: "No active GitHub connection is available for this tenant",
      github_connection_ambiguous: "More than one GitHub connection matches this request",
      github_connection_invalid: "The tenant GitHub connection is incomplete or invalid",
    }[code]);
    this.name = "TenantGitHubConnectionError";
  }
}

interface GitHubAppCredentials {
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: number;
  GITHUB_APP_PRIVATE_KEY: string;
}

interface TenantGitHubConnectionResolverOptions {
  createPublisher?: (credentials: GitHubAppCredentials) => GitHubPublisher;
  createTokenProvider?: (credentials: GitHubAppCredentials) => Pick<GitHubInstallationTokenProvider, "readToken">;
  maxCachedConnections?: number;
}

/**
 * Resolves GitHub App credentials at request time from the tenant-owned,
 * encrypted connection registry. Public connection configuration may contain
 * only a repository owner selector; every credential remains encrypted at rest.
 */
export class TenantGitHubConnectionResolver {
  private readonly publishers = new Map<string, GitHubPublisher>();
  private readonly tokenProviders = new Map<string, Pick<GitHubInstallationTokenProvider, "readToken">>();
  private readonly createPublisher: (credentials: GitHubAppCredentials) => GitHubPublisher;
  private readonly createTokenProvider: (credentials: GitHubAppCredentials) => Pick<GitHubInstallationTokenProvider, "readToken">;
  private readonly maxCachedConnections: number;

  constructor(
    private readonly connections: ExternalConnectionStore,
    options: TenantGitHubConnectionResolverOptions = {},
  ) {
    this.createPublisher = options.createPublisher ?? (credentials => new GitHubPublisher(createGitHubClient(credentials)));
    this.createTokenProvider = options.createTokenProvider ?? (credentials => new GitHubInstallationTokenProvider(credentials));
    this.maxCachedConnections = options.maxCachedConnections ?? 100;
    if (!Number.isInteger(this.maxCachedConnections) || this.maxCachedConnections < 1) {
      throw new RangeError("maxCachedConnections must be a positive integer");
    }
  }

  async publisher(tenantId: string, repositoryOwner: string): Promise<GitHubPublisher> {
    const connection = selectConnection(await this.activeConnections(tenantId), repositoryOwner);
    const key = cacheKey(connection);
    const cached = this.publishers.get(key);
    if (cached) return cached;
    const publisher = this.safeCreate(() => this.createPublisher(githubAppCredentials(connection)));
    this.remember(this.publishers, key, publisher);
    return publisher;
  }

  async installationToken(tenantId: string): Promise<string> {
    const connections = await this.activeConnections(tenantId);
    if (connections.length === 0) throw new TenantGitHubConnectionError("github_connection_not_found");
    if (connections.length !== 1) throw new TenantGitHubConnectionError("github_connection_ambiguous");
    const connection = connections[0]!;
    const key = cacheKey(connection);
    let provider = this.tokenProviders.get(key);
    if (!provider) {
      provider = this.safeCreate(() => this.createTokenProvider(githubAppCredentials(connection)));
      this.remember(this.tokenProviders, key, provider);
    }
    try {
      return await provider.readToken();
    } catch {
      throw new TenantGitHubConnectionError("github_connection_invalid");
    }
  }

  private async activeConnections(tenantId: string): Promise<readonly RuntimeExternalConnection[]> {
    try {
      return await this.connections.findActive(tenantId, "github");
    } catch {
      throw new TenantGitHubConnectionError("github_connection_invalid");
    }
  }

  private safeCreate<T>(create: () => T): T {
    try {
      return create();
    } catch {
      throw new TenantGitHubConnectionError("github_connection_invalid");
    }
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T): void {
    if (cache.size >= this.maxCachedConnections) cache.clear();
    cache.set(key, value);
  }
}

function selectConnection(
  connections: readonly RuntimeExternalConnection[],
  repositoryOwnerInput: string,
): RuntimeExternalConnection {
  const repositoryOwner = repositoryOwnerInput.trim().toLowerCase();
  if (!repositoryOwner) throw new TenantGitHubConnectionError("github_connection_invalid");
  const exact = connections.filter(connection => configuredOwner(connection) === repositoryOwner);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new TenantGitHubConnectionError("github_connection_ambiguous");
  const defaults = connections.filter(connection => configuredOwner(connection) === undefined);
  if (defaults.length === 1) return defaults[0]!;
  if (defaults.length > 1) throw new TenantGitHubConnectionError("github_connection_ambiguous");
  throw new TenantGitHubConnectionError("github_connection_not_found");
}

function configuredOwner(connection: RuntimeExternalConnection): string | undefined {
  const value = connection.configuration.repositoryOwner;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TenantGitHubConnectionError("github_connection_invalid");
  }
  return value.trim().toLowerCase();
}

function githubAppCredentials(connection: RuntimeExternalConnection): GitHubAppCredentials {
  const appId = connection.credentials.appId?.trim();
  const privateKey = connection.credentials.privateKey?.trim();
  const installationId = Number(connection.credentials.installationId);
  if (!appId || !privateKey || !Number.isSafeInteger(installationId) || installationId < 1) {
    throw new TenantGitHubConnectionError("github_connection_invalid");
  }
  return {
    GITHUB_APP_ID: appId,
    GITHUB_APP_INSTALLATION_ID: installationId,
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
}

function cacheKey(connection: RuntimeExternalConnection): string {
  return [connection.tenantId, connection.id, connection.revision, connection.credentialFingerprint].join(":");
}
