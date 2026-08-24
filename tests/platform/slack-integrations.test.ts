import { createHmac } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { describe, expect, it, vi } from "vitest";
import { decryptSlackCredential, encryptSlackCredential } from "../../src/platform/channels/slack-credentials.ts";
import {
  InMemorySlackInstallationRepository,
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
  teamName: "MoeGo QA",
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
});

describe("Slack Web API token verifier", () => {
  it("resolves the App identity through bots.info when auth.test omits app_id", async () => {
    const authTest = vi.fn(async () => ({
      ok: true,
      team: "MoeGo QA",
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

    await expect(verifier.verify("xoxb-test-token")).resolves.toEqual({
      appId: "A123",
      appName: "Qasey",
      teamId: "T123",
      teamName: "MoeGo QA",
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
    expect(JSON.stringify(await repository.list("tenant-1"))).not.toContain("signing-secret-value");
    expect(await repository.get("tenant-2", created.id)).toBeUndefined();
    await expect(repository.getRuntimeByWebhookId(created.webhookId)).resolves.toMatchObject({
      botToken: "xoxb-secret", signingSecret: "signing-secret-value", agentId: "qasey-main",
    });
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
    const registry = new TriggerProviderRegistry([new SlackTriggerProvider(manager)]);

    expect(registry.listProviders()).toEqual([expect.objectContaining({ id: "slack", category: "channel" })]);
    await expect(registry.targets("slack", "tenant-1")).resolves.toEqual([
      expect.objectContaining({ id: "agent:qasey-main", kind: "agent", resourceId: "qasey-main" }),
    ]);

    const created = await registry.create("slack", {
      tenantId: "tenant-1", actorId: "admin-1", displayName: "QA Slack",
      targetId: "agent:qasey-main",
      configuration: { botToken: "xoxb-secret", signingSecret: "signing-secret-value" },
    });
    expect(created).toMatchObject({ providerId: "slack", target: { id: "agent:qasey-main" } });
    expect(JSON.stringify(created)).not.toContain("xoxb-secret");
    await expect(registry.listConnections("tenant-1")).resolves.toEqual([expect.objectContaining({ id: created.id })]);
  });
});

describe("managed Slack webhook provider", () => {
  it("activates an installation only after a signed Slack URL verification", async () => {
    const previousGitHubConfig = {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    };
    Object.assign(process.env, {
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: "test-private-key",
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
      });
      const provider = new ManagedSlackProvider(manager);

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
