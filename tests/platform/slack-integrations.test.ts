import { createHmac } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { describe, expect, it, vi } from "vitest";
import { decryptSlackCredential, encryptSlackCredential } from "../../src/platform/channels/slack-credentials.ts";
import {
  InMemorySlackInstallationRepository,
  PrismaSlackInstallationRepository,
  SlackInstallationRepositoryError,
} from "../../src/platform/channels/slack-installation-repository.ts";
import {
  SlackIntegrationManager,
  SlackWebApiTokenVerifier,
  type SlackTokenVerifier,
} from "../../src/platform/channels/slack-integration-manager.ts";
import { TriggerProviderRegistry } from "../../src/platform/triggers/trigger-provider-registry.ts";
import { SlackTriggerProvider } from "../../src/platform/triggers/slack-trigger-provider.ts";

const encryptionKey = "test-managed-slack-encryption-key";
const identity = {
  appId: "A123",
  appName: "qasey",
  teamId: "T123",
  teamName: "Qasey QA",
  botUserId: "U123",
  botId: "B123",
};
const verifier: SlackTokenVerifier = { verify: async () => identity };

describe("managed Slack App credentials", () => {
  it("binds ciphertext to its tenant, installation, and credential field", () => {
    const context = { tenantId: "tenant-1", installationId: "installation-1", field: "bot-token" as const };
    const encrypted = encryptSlackCredential("xoxb-secret", encryptionKey, context);
    expect(encrypted).not.toContain("xoxb-secret");
    expect(decryptSlackCredential(encrypted, encryptionKey, context)).toBe("xoxb-secret");
    expect(() => decryptSlackCredential(encrypted, encryptionKey, { ...context, tenantId: "tenant-2" })).toThrow();
    expect(() => decryptSlackCredential(encrypted, encryptionKey, { ...context, field: "signing-secret" })).toThrow();
  });

  it("binds versioned ciphertext to its declared key ID", () => {
    const context = { tenantId: "tenant-1", installationId: "installation-1", field: "bot-token" as const };
    const encrypted = encryptSlackCredential("xoxb-secret", encryptionKey, context, "key-2026-09");
    expect(decryptSlackCredential(encrypted, encryptionKey, context, "key-2026-09")).toBe("xoxb-secret");
    expect(() => decryptSlackCredential(encrypted, encryptionKey, context, "default")).toThrow();
  });
});

describe("Slack Web API token verifier", () => {
  it("resolves the App identity through bots.info when auth.test omits app_id", async () => {
    const authTest = vi.fn(async () => ({
      ok: true,
      team: "Qasey QA",
      team_id: "T123",
      user_id: "U123",
      bot_id: "B123",
    }));
    const botsInfo = vi.fn(async () => ({
      ok: true,
      bot: { app_id: "A123", name: "Qasey" },
    }));
    const verifier = new SlackWebApiTokenVerifier(() => ({
      auth: { test: authTest },
      bots: { info: botsInfo },
    }));

    const botToken = ["xoxb", "test-token-value"].join("-");
    await expect(verifier.verify(botToken)).resolves.toEqual({
      appId: "A123",
      appName: "Qasey",
      teamId: "T123",
      teamName: "Qasey QA",
      botUserId: "U123",
      botId: "B123",
    });
    expect(botsInfo).toHaveBeenCalledWith({ bot: "B123", team_id: "T123" });
  });
});

describe("managed Slack App repository", () => {
  it("keeps secrets out of public records and isolates tenant lookups", async () => {
    const repository = new InMemorySlackInstallationRepository(encryptionKey);
    const created = await repository.create({
      tenantId: "tenant-1", actorId: "admin-1", displayName: "QA Slack", agentId: "qasey-main",
      identity, botToken: "xoxb-secret", signingSecret: "signing-secret-value",
    });

    expect(JSON.stringify(created)).not.toContain("xoxb-secret");
    expect(created.devRuntimeEnabled).toBe(false);
    expect(created.devRuntimeCommand).toBe("/qasey-local");
    expect(JSON.stringify(await repository.list("tenant-1"))).not.toContain("signing-secret-value");
    expect(await repository.get("tenant-2", created.id)).toBeUndefined();
    await expect(repository.getRuntimeByWebhookId(created.webhookId)).resolves.toMatchObject({
      botToken: "xoxb-secret", signingSecret: "signing-secret-value", agentId: "qasey-main",
    });
  });

  it("uses the persisted key ID for Prisma reads and keeps plaintext out of CAS persistence", async () => {
    const oldKey = "legacy-slack-credential-key-that-is-at-least-32-bytes";
    const nextKey = "next-slack-credential-key-that-is-at-least-32-bytes";
    const installationId = "4db6dc62-c481-45a4-95d0-00a85e47bc8b";
    const tenantId = "tenant-1";
    const databaseToken = ["xoxb", "database-secret"].join("-");
    let row = {
      id: installationId,
      tenant_id: tenantId,
      webhook_id: "8f669788-11e4-4b88-bc4a-1e7134321319",
      display_name: "Legacy Slack",
      slack_app_id: identity.appId,
      slack_app_name: identity.appName,
      slack_team_id: identity.teamId,
      slack_team_name: identity.teamName,
      slack_bot_user_id: identity.botUserId,
      slack_bot_id: identity.botId,
      is_enterprise_install: false,
      dev_runtime_enabled: false,
      dev_runtime_command: "/qasey-local",
      bot_token_ciphertext: encryptSlackCredential(databaseToken, oldKey, {
        tenantId, installationId, field: "bot-token",
      }),
      signing_secret_ciphertext: encryptSlackCredential("database-signing-secret", oldKey, {
        tenantId, installationId, field: "signing-secret",
      }),
      credential_key_id: "default",
      credential_fingerprint: "redacted-fingerprint",
      status: "active" as const,
      webhook_verified_at: new Date("2026-08-01T00:00:00.000Z"),
      last_token_verified_at: new Date("2026-08-01T00:00:00.000Z"),
      last_error_code: null,
      revision: 1,
      created_at: new Date("2026-08-01T00:00:00.000Z"),
      updated_at: new Date("2026-08-01T00:00:00.000Z"),
      agent_id: "qasey-main",
    };
    const queryRawUnsafe = vi.fn(async () => [row]);
    const executeRawUnsafe = vi.fn(async (sql: string, ...parameters: unknown[]) => {
      if (sql.includes("bot_token_ciphertext=$4")) {
        row = {
          ...row,
          bot_token_ciphertext: String(parameters[3]),
          signing_secret_ciphertext: String(parameters[4]),
          credential_key_id: String(parameters[5]),
          credential_fingerprint: String(parameters[6]),
          revision: 2,
          updated_at: new Date("2026-08-02T00:00:00.000Z"),
        };
      }
      return 1;
    });
    const prisma = {
      $connect: vi.fn(async () => undefined),
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
    };
    const repository = new PrismaSlackInstallationRepository(prisma as never, {
      activeKeyId: "key-2026-09",
      keys: { default: oldKey, "key-2026-09": nextKey },
    });
    await repository.init();

    const rotated = await repository.rotateCredentials(tenantId, installationId, 1, "security-admin");
    expect(rotated).toMatchObject({ credentialKeyId: "key-2026-09", revision: 2, status: "active" });
    const updateCall = executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes("bot_token_ciphertext=$4"));
    expect(updateCall?.[0]).toContain("credential_key_id=$6");
    expect(JSON.stringify(updateCall)).not.toContain(databaseToken);
    expect(JSON.stringify(updateCall)).not.toContain("database-signing-secret");
    await expect(repository.getRuntimeByWebhookId(row.webhook_id)).resolves.toMatchObject({
      botToken: databaseToken,
      signingSecret: "database-signing-secret",
      credentialKeyId: "key-2026-09",
    });
    await expect(repository.rotateCredentials(tenantId, installationId, 1, "security-admin"))
      .rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("enforces one active App/workspace registration and optimistic revisions", async () => {
    const repository = new InMemorySlackInstallationRepository(encryptionKey);
    const input = {
      tenantId: "tenant-1", actorId: "admin-1", displayName: "QA Slack", agentId: "qasey-main",
      identity, botToken: "xoxb-secret", signingSecret: "signing-secret-value",
    };
    const created = await repository.create(input);
    await expect(repository.create({ ...input, tenantId: "tenant-2" })).rejects.toMatchObject({ code: "duplicate" });

    const rebound = await repository.rebind("tenant-1", created.id, "qasey-secondary", created.revision, "admin-1");
    expect(rebound).toMatchObject({ agentId: "qasey-secondary", revision: 2 });
    await expect(repository.setEnabled("tenant-1", created.id, false, created.revision, "admin-1"))
      .rejects.toBeInstanceOf(SlackInstallationRepositoryError);

    const disabled = await repository.setEnabled("tenant-1", created.id, false, rebound.revision, "admin-1");
    expect(disabled.status).toBe("disabled");
    await repository.markWebhookVerified(created.webhookId);
    expect((await repository.get("tenant-1", created.id))?.status).toBe("disabled");
  });

  it("rotates legacy default ciphertext to the active key with CAS and retains previous keys only for reads", async () => {
    const keys: Record<string, string> = {
      default: "legacy-slack-credential-key-that-is-at-least-32-bytes",
      "key-2026-09": "next-slack-credential-key-that-is-at-least-32-bytes",
    };
    const keyring = { activeKeyId: "default", keys };
    const repository = new InMemorySlackInstallationRepository(keyring);
    const legacyToken = ["xoxb", "legacy-secret"].join("-");
    const rotatedToken = ["xoxb", "rotated-secret"].join("-");
    const oldOnly = await repository.create({
      tenantId: "tenant-1", actorId: "admin-1", displayName: "Legacy Slack", agentId: "qasey-main",
      identity, botToken: legacyToken, signingSecret: "legacy-signing-secret-value",
    });
    const rotatable = await repository.create({
      tenantId: "tenant-1", actorId: "admin-1", displayName: "Rotatable Slack", agentId: "qasey-main",
      identity: { ...identity, teamId: "T456" },
      botToken: rotatedToken, signingSecret: "rotated-signing-secret-value",
    });

    keyring.activeKeyId = "key-2026-09";
    const rotated = await repository.rotateCredentials(
      "tenant-1", rotatable.id, rotatable.revision, "security-admin",
    );
    expect(rotated).toMatchObject({ credentialKeyId: "key-2026-09", revision: rotatable.revision + 1 });
    expect(JSON.stringify(rotated)).not.toContain(rotatedToken);
    await expect(repository.rotateCredentials("tenant-1", rotatable.id, rotatable.revision, "security-admin"))
      .rejects.toMatchObject({ code: "revision_conflict" });
    await expect(repository.getRuntimeByWebhookId(rotatable.webhookId)).resolves.toMatchObject({
      botToken: rotatedToken, signingSecret: "rotated-signing-secret-value",
    });

    delete keys.default;
    await expect(repository.getRuntimeByWebhookId(oldOnly.webhookId)).rejects.toMatchObject({
      code: "key_unavailable",
    });
    await expect(repository.getRuntimeByWebhookId(rotatable.webhookId)).resolves.toMatchObject({
      botToken: rotatedToken,
    });
  });
});

describe("Slack integration manager", () => {
  it("verifies BYO credentials and returns a stable webhook URL", async () => {
    const repository = new InMemorySlackInstallationRepository(encryptionKey);
    const manager = new SlackIntegrationManager(repository, "https://qasey.example.com/", [
      { applicationId: "qasey", agentId: "qasey-main", name: "Qasey" },
    ], verifier);
    const created = await manager.create({
      tenantId: "tenant-1", actorId: "admin-1", displayName: "QA Slack", agentId: "qasey-main",
      credentials: { botToken: "xoxb-secret", signingSecret: "signing-secret-value" },
    });
    expect(created.webhookUrl).toBe(`https://qasey.example.com/channels/slack/apps/${created.webhookId}/events`);
    expect(created.identity).toEqual(identity);
    await expect(manager.create({
      tenantId: "tenant-1", actorId: "admin-1", displayName: "Bad", agentId: "unknown",
      credentials: { botToken: "xoxb-secret", signingSecret: "signing-secret-value" },
    })).rejects.toMatchObject({ code: "invalid_target" });
  });
});

describe("Trigger provider registry", () => {
  it("exposes Slack as one provider behind provider-neutral connections and targets", async () => {
    const repository = new InMemorySlackInstallationRepository(encryptionKey);
    const manager = new SlackIntegrationManager(repository, "https://qasey.example.com", [
      { applicationId: "qasey", agentId: "qasey-main", name: "Qasey" },
    ], verifier);
    const changed = vi.fn();
    const registry = new TriggerProviderRegistry([new SlackTriggerProvider(manager, changed, {
      slashCommand: {
        command: "/qasey-local",
        description: "绑定本地 Qasey Runtime",
        usageHint: "bind <runtime-id> | unbind | status",
        requiredScope: "commands",
      },
    })]);

    expect(registry.listProviders()).toEqual([expect.objectContaining({
      id: "slack",
      category: "channel",
      fields: expect.arrayContaining([
        expect.objectContaining({ key: "devRuntimeEnabled", type: "boolean" }),
        expect.objectContaining({ key: "devRuntimeCommand", type: "text", placeholder: "/qasey-local" }),
      ]),
    })]);
    await expect(registry.targets("slack", "tenant-1")).resolves.toEqual([
      expect.objectContaining({ id: "agent:qasey-main", kind: "agent", resourceId: "qasey-main" }),
    ]);

    const created = await registry.create("slack", {
      tenantId: "tenant-1", actorId: "admin-1", displayName: "QA Slack",
      targetId: "agent:qasey-main",
      configuration: {
        botToken: "xoxb-secret",
        signingSecret: "signing-secret-value",
        devRuntimeEnabled: "true",
        devRuntimeCommand: "/qa-local",
      },
    });
    expect(created).toMatchObject({
      providerId: "slack",
      credentialKeyId: "default",
      target: { id: "agent:qasey-main" },
      configurationValues: { devRuntimeEnabled: "true", devRuntimeCommand: "/qa-local" },
    });
    expect(created.setupFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "slash-command", value: "/qa-local" }),
      expect.objectContaining({ key: "slash-command-request-url", value: created.endpoint?.url }),
      expect.objectContaining({ key: "slash-command-scope", value: "commands" }),
    ]));
    expect(JSON.stringify(created)).not.toContain("xoxb-secret");
    const cloudOnly = await registry.updateConfiguration("slack", {
      tenantId: "tenant-1",
      actorId: "admin-1",
      id: created.id,
      revision: created.revision,
      configuration: { devRuntimeEnabled: "false", devRuntimeCommand: "/qa-runtime" },
    });
    expect(cloudOnly).toMatchObject({
      id: created.id,
      status: "awaiting_webhook",
      configurationValues: { devRuntimeEnabled: "false", devRuntimeCommand: "/qa-runtime" },
    });
    expect(cloudOnly.setupFields).toBeUndefined();
    expect(changed).toHaveBeenCalledWith(created.id);
    const rotated = await registry.rotateCredentials("slack", {
      tenantId: "tenant-1", actorId: "security-admin", id: created.id, revision: cloudOnly.revision,
    });
    expect(rotated.revision).toBe(cloudOnly.revision + 1);
    await expect(registry.listConnections("tenant-1")).resolves.toEqual([expect.objectContaining({
      id: created.id,
      configurationValues: { devRuntimeEnabled: "false", devRuntimeCommand: "/qa-runtime" },
    })]);

    await expect(registry.create("slack", {
      tenantId: "tenant-1",
      actorId: "admin-1",
      displayName: "Invalid command",
      targetId: "agent:qasey-main",
      configuration: {
        botToken: "xoxb-secret",
        signingSecret: "signing-secret-value",
        devRuntimeEnabled: "true",
        devRuntimeCommand: "qa local",
      },
    })).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});

describe("managed Slack webhook provider", () => {
  it("activates an installation only after a signed Slack URL verification", async () => {
    const previousGitHubConfig = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    Object.assign(process.env, {
      GITHUB_TOKEN: "synthetic-personal-access-token-at-least-32-bytes",
    });

    try {
      const { ManagedSlackProvider } = await import("../../src/mastra/managed-slack-provider.ts");
      const repository = new InMemorySlackInstallationRepository(encryptionKey);
      const manager = new SlackIntegrationManager(repository, "https://qasey.example.com", [
        { applicationId: "qasey", agentId: "qasey-main", name: "Qasey" },
      ], verifier);
      const connection = await manager.create({
        tenantId: "tenant-1", actorId: "admin-1", displayName: "QA Slack", agentId: "qasey-main",
        credentials: { botToken: "xoxb-secret", signingSecret: "signing-secret-value" },
        devRuntimeEnabled: true,
        devRuntimeCommand: "/qa-local",
      });
      const bridgeReady = vi.fn();
      const provider = new ManagedSlackProvider(manager, { onBridgeReady: bridgeReady });

      try {
        new Mastra({
          agents: {
            "qasey-main": new Agent({ id: "qasey-main", name: "Qasey", instructions: "Test", model: "openai/gpt-5" }),
          },
          channels: { slack: provider },
        });
        const body = JSON.stringify({ type: "url_verification", challenge: "challenge-value", team_id: identity.teamId });
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const signature = `v0=${createHmac("sha256", "signing-secret-value").update(`v0:${timestamp}:${body}`).digest("hex")}`;
        const request = new Request(connection.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
          body,
        });
        const route = provider.getRoutes()[0] as { handler: (context: any) => Promise<Response> };
        const response = await route.handler({
          req: { raw: request, param: (name: string) => name === "webhookId" ? connection.webhookId : undefined },
          json: (value: unknown, status = 200) => Response.json(value, { status }),
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("challenge-value");
        expect((await repository.get("tenant-1", connection.id))?.status).toBe("active");
        expect(bridgeReady).toHaveBeenCalledWith(expect.objectContaining({
          installation: expect.objectContaining({
            id: connection.id,
            devRuntimeEnabled: true,
            devRuntimeCommand: "/qa-local",
            identity: expect.objectContaining({ teamId: identity.teamId }),
          }),
        }));
      } finally {
        await provider.close();
      }
    } finally {
      for (const key of Object.keys(previousGitHubConfig) as Array<keyof typeof previousGitHubConfig>) {
        const previousValue = previousGitHubConfig[key];
        if (previousValue === undefined) delete process.env[key];
        else process.env[key] = previousValue;
      }
    }
  });
});
