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
    await createConnection(store, "tenant-a", "octo", "octo");
    await createConnection(store, "tenant-a", "other", "other");
    await createConnection(store, "tenant-b", "octo", "wrong-tenant");
    const createPublisher = vi.fn(() => new GitHubPublisher());
    const resolver = new TenantGitHubConnectionResolver(store, { createPublisher });

    await expect(resolver.publisher("tenant-a", "OCTO")).resolves.toBeInstanceOf(GitHubPublisher);
    expect(createPublisher).toHaveBeenCalledTimes(1);
    expect(createPublisher).toHaveBeenCalledWith({ GITHUB_TOKEN: tokenFor("octo") });
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

  it("returns a tenant-bound PAT only with one active connection and observes rotation", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    const connection = await createConnection(store, "tenant-a", "octo", "octo");
    const resolver = new TenantGitHubConnectionResolver(store);

    await expect(resolver.token("tenant-a")).resolves.toBe(tokenFor("octo"));

    await store.update({
      tenantId: "tenant-a",
      id: connection.id,
      expectedRevision: connection.revision,
      credentials: tokenCredentials("octo-next"),
      actorId: "security-admin",
    });
    await expect(resolver.token("tenant-a")).resolves.toBe(tokenFor("octo-next"));
  });

  it("returns only stable errors for malformed credentials", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    await store.create({
      tenantId: "tenant-a",
      provider: "github",
      name: "broken",
      credentials: { token: "short-secret-token" },
      actorId: "admin",
    });
    const resolver = new TenantGitHubConnectionResolver(store);

    const error = await resolver.token("tenant-a").catch(value => value) as TenantGitHubConnectionError;
    expect(error).toMatchObject({ code: "github_connection_invalid" });
    expect(error.message).not.toContain("short-secret-token");
  });
});

async function createConnection(
  store: InMemoryExternalConnectionStore,
  tenantId: string,
  repositoryOwner: string | undefined,
  tokenSuffix: string,
  suffix = tokenSuffix,
) {
  return store.create({
    tenantId,
    provider: "github",
    name: `github-${suffix}`,
    ...(repositoryOwner ? { configuration: { repositoryOwner } } : {}),
    credentials: tokenCredentials(tokenSuffix),
    actorId: "admin",
  });
}

function tokenCredentials(suffix: string): Readonly<Record<string, string>> {
  return { token: tokenFor(suffix) };
}

function tokenFor(suffix: string): string {
  return `synthetic-personal-access-token-${suffix}-at-least-32-bytes`;
}
