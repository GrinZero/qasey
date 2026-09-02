import { AgentChannels } from "@mastra/core/channels";
import type { ChannelInstallationInfo, ChannelPlatformInfo, ChannelProvider } from "@mastra/core/channels";
import type { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import type { SlackIntegrationManager } from "../platform/channels/slack-integration-manager.ts";
import type { SlackRuntimeInstallation } from "../platform/channels/slack-installation-repository.ts";
import { createQaseySlackChannelConfig } from "./applications/qasey/channels.ts";

interface ManagedSlackBridge {
  revision: number;
  channels: AgentChannels;
}

export interface ManagedSlackProviderOptions {
  onBridgeReady?: (context: {
    mastra: Mastra;
    channels: AgentChannels;
    installation: SlackRuntimeInstallation;
  }) => void | Promise<void>;
}

/**
 * BYO Slack App provider. App creation and credentials live in Qasey's Admin
 * control plane; this provider owns only signed ingress and runtime bridges.
 */
export class ManagedSlackProvider implements ChannelProvider {
  readonly id = "slack";
  private mastra?: Mastra;
  private readonly bridges = new Map<string, ManagedSlackBridge>();

  constructor(
    private readonly integrations: SlackIntegrationManager,
    private readonly options: ManagedSlackProviderOptions = {},
  ) {}

  __attach(mastra: Mastra): void { this.mastra = mastra; }

  getInfo(): ChannelPlatformInfo {
    return { id: this.id, name: "Slack", isConfigured: true };
  }

  async listInstallations(): Promise<ChannelInstallationInfo[]> {
    // The generic Mastra API has no tenant context. Tenant-scoped installation
    // discovery is deliberately exposed only through Qasey's Admin BFF.
    return [];
  }

  getRoutes() {
    return [registerApiRoute("/channels/slack/apps/:webhookId/events", {
      method: "POST",
      requiresAuth: false,
      handler: async c => {
        const webhookId = c.req.param("webhookId");
        const installation = await this.integrations.repository.getRuntimeByWebhookId(webhookId);
        if (!installation) return c.json({ error: "not_found" }, 404);
        if (installation.status === "disabled") return c.json({ error: "disabled" }, 410);

        const isChallenge = await requestIsUrlVerification(c.req.raw);
        if (installation.status === "awaiting_webhook" && !isChallenge) {
          return c.json({ error: "webhook_not_verified" }, 409);
        }

        try {
          const bridge = await this.bridgeFor(installation);
          const response = await bridge.channels.handleWebhookEvent("slack", c.req.raw);
          if (isChallenge && response.ok) {
            await this.integrations.repository.markWebhookVerified(webhookId);
            this.invalidate(installation.id);
          }
          return response;
        } catch (error) {
          await this.integrations.repository.markError(webhookId, "runtime_bridge_failed");
          throw error;
        }
      },
    })];
  }

  invalidate(installationId: string): void {
    this.bridges.get(installationId)?.channels.close();
    this.bridges.delete(installationId);
  }

  async close(): Promise<void> {
    for (const bridge of this.bridges.values()) bridge.channels.close();
    this.bridges.clear();
  }

  private async bridgeFor(installation: SlackRuntimeInstallation): Promise<ManagedSlackBridge> {
    const existing = this.bridges.get(installation.id);
    if (existing?.revision === installation.revision) return existing;
    if (!this.mastra) throw new Error("ManagedSlackProvider has not been attached to Mastra");

    existing?.channels.close();

    const agent = this.mastra.getAgentById(installation.agentId as never);
    const channels = new AgentChannels(createQaseySlackChannelConfig({
      mode: "webhook",
      botToken: installation.botToken,
      signingSecret: installation.signingSecret,
      botUserId: installation.identity.botUserId,
      tenantId: installation.tenantId,
      installationId: installation.id,
      slackWorkspaceId: installation.identity.teamId,
      devRuntimeTunnelEnabled: installation.devRuntimeEnabled,
    }));
    channels.__setAgent(agent);
    channels.__setLogger(this.mastra.getLogger());
    await channels.initialize(this.mastra);
    await this.options.onBridgeReady?.({ mastra: this.mastra, channels, installation });
    const bridge = { revision: installation.revision, channels };
    this.bridges.set(installation.id, bridge);
    return bridge;
  }
}

async function requestIsUrlVerification(request: Request): Promise<boolean> {
  try {
    const body = await request.clone().json() as { type?: unknown };
    return body.type === "url_verification";
  } catch {
    return false;
  }
}
