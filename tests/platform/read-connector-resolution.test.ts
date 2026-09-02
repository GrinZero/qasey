import { describe, expect, it } from "vitest";
import { loadConfig, ReadConnectorCatalog } from "../../packages/adapters/src/index.ts";
import { InMemoryExternalConnectionStore } from "../../src/platform/connections/connection-store.ts";
import { ConnectionBackedReadConnectorResolver } from "../../src/platform/connections/read-connector-resolver.ts";

const keyring = {
  activeKeyId: "default",
  keys: { default: "read-connector-credential-key-over-32-bytes" },
};

describe("request-scoped read connector resolution", () => {
  it("returns only tools backed by the trusted tenant's active connections", async () => {
    const connections = new InMemoryExternalConnectionStore(keyring);
    await connections.create({
      tenantId: "tenant-a", provider: "slack", name: "primary",
      credentials: { botToken: "redacted-tenant-a-slack-credential" }, actorId: "admin-a",
    });
    await connections.create({
      tenantId: "tenant-b", provider: "jira", name: "primary",
      configuration: { baseUrl: "https://jira.example.com" },
      credentials: { email: "qa@example.com", apiToken: "tenant-b-redacted" }, actorId: "admin-b",
    });
    const catalog = new ReadConnectorCatalog(loadConfig({
      NODE_ENV: "test", QASEY_TENANCY_MODE: "multi",
    } as NodeJS.ProcessEnv), new ConnectionBackedReadConnectorResolver(connections));

    expect(Object.keys(await catalog.toolsForTenant("tenant-a")).sort()).toEqual([
      "slack_get_file", "slack_get_history", "slack_get_thread", "slack_get_user",
    ]);
    expect(Object.keys(await catalog.toolsForTenant("tenant-b")).sort()).toEqual([
      "jira_get_issue", "jira_search_issues",
    ]);
    await expect(catalog.toolsForTenant("tenant-c")).resolves.toEqual({});
    await expect(catalog.toolsForTenant(undefined)).resolves.toEqual({});
  });

  it("does not merge process-global credentials into multi-tenant resolution", async () => {
    const connections = new InMemoryExternalConnectionStore(keyring);
    const config = loadConfig({ NODE_ENV: "test", QASEY_TENANCY_MODE: "multi" } as NodeJS.ProcessEnv);
    const catalog = new ReadConnectorCatalog(config, new ConnectionBackedReadConnectorResolver(connections));
    await expect(catalog.toolsForTenant("tenant-a")).resolves.toEqual({});
  });

  it.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://jira.local",
    "https://user:password@jira.example.com",
  ])("does not construct Jira tools for a non-public tenant endpoint %s", async baseUrl => {
    const connections = new InMemoryExternalConnectionStore(keyring);
    await connections.create({
      tenantId: "tenant-a", provider: "jira", name: "unsafe",
      configuration: { baseUrl },
      credentials: { email: "qa@example.com", apiToken: "redacted" }, actorId: "admin-a",
    });
    const catalog = new ReadConnectorCatalog(
      loadConfig({ NODE_ENV: "test", QASEY_TENANCY_MODE: "multi" } as NodeJS.ProcessEnv),
      new ConnectionBackedReadConnectorResolver(connections),
    );

    await expect(catalog.toolsForTenant("tenant-a")).resolves.toEqual({});
  });
});
