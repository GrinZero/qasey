import { describe, expect, it } from "vitest";
import {
  ExternalConnectionStoreError,
  InMemoryExternalConnectionStore,
} from "../../src/platform/connections/connection-store.ts";

const keyring = {
  activeKeyId: "key-2026-08",
  keys: { "key-2026-08": "credential-encryption-key-at-least-32-bytes" },
};

describe("tenant-bound external connections", () => {
  it("rejects secrets placed in publicly returned configuration", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    await expect(store.create({
      tenantId: "tenant-a",
      provider: "jira",
      name: "jira",
      configuration: { nested: { apiToken: "must-not-be-public" } },
      credentials: { apiToken: "encrypted-value" },
      actorId: "admin",
    })).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(store.create({
      tenantId: "tenant-a",
      provider: "jira",
      name: "non-json",
      configuration: { toJSON: () => undefined },
      credentials: { apiToken: "encrypted-value" },
      actorId: "admin",
    })).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("never exposes credentials through public reads and isolates tenants", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    const created = await store.create({
      tenantId: "tenant-a",
      provider: "jira",
      name: "primary",
      configuration: { baseUrl: "https://jira.example.com" },
      credentials: { email: "qa@example.com", apiToken: "secret-token" },
      actorId: "admin-a",
    });

    expect(JSON.stringify(created)).not.toContain("secret-token");
    expect(JSON.stringify(await store.list("tenant-a"))).not.toContain("secret-token");
    await expect(store.get("tenant-b", created.id)).resolves.toBeUndefined();
    await expect(store.getRuntime("tenant-b", created.id)).resolves.toBeUndefined();
    await expect(store.findActive("tenant-b", "jira")).resolves.toEqual([]);
    await expect(store.getRuntime("tenant-a", created.id)).resolves.toMatchObject({
      tenantId: "tenant-a",
      credentials: { email: "qa@example.com", apiToken: "secret-token" },
    });
  });

  it("uses optimistic concurrency and immediately removes revoked credentials from resolution", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    const created = await store.create({
      tenantId: "tenant-a", provider: "slack", name: "workspace",
      credentials: { botToken: "redacted-slack-bot-credential" }, actorId: "admin-a",
    });
    const updated = await store.update({
      tenantId: "tenant-a", id: created.id, expectedRevision: created.revision,
      status: "disabled", actorId: "admin-a",
    });
    await expect(store.update({
      tenantId: "tenant-a", id: created.id, expectedRevision: created.revision,
      status: "active", actorId: "admin-a",
    })).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(store.findActive("tenant-a", "slack")).resolves.toEqual([]);
    const revoked = await store.revoke("tenant-a", created.id, updated.revision, "admin-a");
    expect(revoked.status).toBe("revoked");
    await expect(store.findActive("tenant-a", "slack")).resolves.toEqual([]);
  });

  it("rotates ciphertext to the active key while retaining older keys for reads", async () => {
    const oldStore = new InMemoryExternalConnectionStore({
      activeKeyId: "old", keys: { old: "old-credential-key-that-is-at-least-32-bytes" },
    });
    const created = await oldStore.create({
      tenantId: "tenant-a", provider: "github", name: "app",
      credentials: { privateKey: "redacted-private-key" }, actorId: "admin-a",
    });
    // The in-memory store owns its records, so validate rotation semantics with
    // one keyring that includes both generations and changes its active ID.
    const mutableKeyring = {
      activeKeyId: "old",
      keys: {
        old: "old-credential-key-that-is-at-least-32-bytes",
        next: "next-credential-key-that-is-at-least-32-bytes",
      },
    };
    const store = new InMemoryExternalConnectionStore(mutableKeyring);
    const connection = await store.create({
      tenantId: "tenant-a", provider: "github", name: "rotatable",
      credentials: { privateKey: "redacted-private-key" }, actorId: "admin-a",
    });
    mutableKeyring.activeKeyId = "next";
    const rotated = await store.rotate("tenant-a", connection.id, connection.revision, "security-admin");
    expect(rotated.credentialKeyId).toBe("next");
    await expect(store.getRuntime("tenant-a", connection.id)).resolves.toMatchObject({
      credentials: { privateKey: "redacted-private-key" },
    });
    expect(created.credentialKeyId).toBe("old");
  });

  it("rejects duplicate names and invalid credential payloads without leaking values", async () => {
    const store = new InMemoryExternalConnectionStore(keyring);
    const input = {
      tenantId: "tenant-a", provider: "mcp" as const, name: "docs",
      credentials: { bearerToken: "redacted-token" }, actorId: "admin-a",
    };
    await store.create(input);
    await expect(store.create(input)).rejects.toBeInstanceOf(ExternalConnectionStoreError);
    await expect(store.create({ ...input, name: "empty", credentials: { bearerToken: "" } }))
      .rejects.not.toThrow(/redacted-token/u);
  });
});
