import { describe, expect, it, vi } from "vitest";
import { GitHubPublisher } from "../../packages/adapters/src/github.ts";
import { InMemoryExternalConnectionStore } from "../../src/platform/connections/connection-store.ts";
import {
  TenantGitHubConnectionError,
  TenantGitHubConnectionResolver,
} from "../../src/platform/connections/github-connection-resolver.ts";

const keyring = {
  activeKeyId: "current",
  keys: { current: "test-credential-encryption-key-at-least-32-bytes" },
};

describe("tenant GitHub connection resolution", () => {
  it("selects an explicit repository owner without crossing tenant boundaries", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    await createConnection(store, "tenant-a", "octo", "app-octo");
    await createConnection(store, "tenant-a", "other", "app-other");
    await createConnection(store, "tenant-b", "octo", "app-wrong-tenant");
    const createPublisher = vi.fn(() => new GitHubPublisher());
    const resolver = new TenantGitHubConnectionResolver(store, { createPublisher });

    await expect(resolver.publisher("tenant-a", "OCTO")).resolves.toBeInstanceOf(GitHubPublisher);
    expect(createPublisher).toHaveBeenCalledTimes(1);
    expect(createPublisher).toHaveBeenCalledWith(expect.objectContaining({ GITHUB_APP_ID: "app-octo" }));
  });

  it("fails closed when repository selection is ambiguous or missing", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    await createConnection(store, "tenant-a", undefined, "default-a");
    await createConnection(store, "tenant-a", undefined, "default-b", "second");
    const resolver = new TenantGitHubConnectionResolver(store, {
      createPublisher: () => new GitHubPublisher(),
    });

    await expect(resolver.publisher("tenant-a", "octo"))
      .rejects.toMatchObject({ code: "github_connection_ambiguous" });
    await expect(resolver.publisher("tenant-b", "octo"))
      .rejects.toMatchObject({ code: "github_connection_not_found" });
  });

  it("issues a tenant-bound short-lived installation token only with one active connection", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    const connection = await createConnection(store, "tenant-a", "octo", "app-octo");
    const readToken = vi.fn(async () => "synthetic-installation-token-at-least-32-bytes");
    const createTokenProvider = vi.fn(() => ({ readToken }));
    const resolver = new TenantGitHubConnectionResolver(store, { createTokenProvider });

    await expect(resolver.installationToken("tenant-a"))
      .resolves.toBe("synthetic-installation-token-at-least-32-bytes");
    await expect(resolver.installationToken("tenant-a"))
      .resolves.toBe("synthetic-installation-token-at-least-32-bytes");
    expect(createTokenProvider).toHaveBeenCalledTimes(1);

    await store.update({
      tenantId: "tenant-a",
      id: connection.id,
      expectedRevision: connection.revision,
      credentials: appCredentials("app-octo-next"),
      actorId: "security-admin",
    });
    await resolver.installationToken("tenant-a");
    expect(createTokenProvider).toHaveBeenCalledTimes(2);
    expect(createTokenProvider).toHaveBeenLastCalledWith(expect.objectContaining({ GITHUB_APP_ID: "app-octo-next" }));
  });

  it("returns only stable errors for malformed credentials", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    await store.create({
      tenantId: "tenant-a",
      provider: "github",
      name: "broken",
      credentials: { appId: "secret-app-id", installationId: "not-a-number", privateKey: "secret-private-key" },
      actorId: "admin",
    });
    const resolver = new TenantGitHubConnectionResolver(store);

    const error = await resolver.installationToken("tenant-a").catch(value => value) as TenantGitHubConnectionError;
    expect(error).toMatchObject({ code: "github_connection_invalid" });
    expect(error.message).not.toContain("secret-app-id");
    expect(error.message).not.toContain("secret-private-key");
  });
});

async function createConnection(
  store: InMemoryExternalConnectionStore,
  tenantId: string,
  repositoryOwner: string | undefined,
  appId: string,
  suffix = appId,
) {
  return store.create({
    tenantId,
    provider: "github",
    name: `github-${suffix}`,
    ...(repositoryOwner ? { configuration: { repositoryOwner } } : {}),
    credentials: appCredentials(appId),
    actorId: "admin",
  });
}

function appCredentials(appId: string): Readonly<Record<string, string>> {
  return {
    appId,
    installationId: "12345",
    privateKey: "synthetic-private-key-value-for-tests",
  };
}
