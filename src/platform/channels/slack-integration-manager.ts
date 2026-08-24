import { WebClient } from "@slack/web-api";
import type {
  SlackInstallation,
  SlackInstallationIdentity,
  SlackInstallationRepository,
} from "./slack-installation-repository.ts";

export interface SlackAppCredentials {
  botToken: string;
  signingSecret: string;
}

export interface SlackConnectionView extends SlackInstallation {
  webhookUrl: string;
}

export interface SlackConnectionTarget {
  applicationId: string;
  agentId: string;
  name: string;
}

export interface SlackTokenVerifier {
  verify(botToken: string): Promise<SlackInstallationIdentity>;
}

interface SlackIdentityWebClient {
  auth: {
    test(): Promise<{
      ok?: boolean;
      app_id?: string;
      app_name?: string;
      bot_id?: string;
      is_enterprise_install?: boolean;
      team?: string;
      team_id?: string;
      user_id?: string;
    }>;
  };
  bots: {
    info(input: { bot: string; team_id: string }): Promise<{
      ok?: boolean;
      bot?: { app_id?: string; name?: string };
    }>;
  };
}

export class SlackWebApiTokenVerifier implements SlackTokenVerifier {
  constructor(
    private readonly createClient: (botToken: string) => SlackIdentityWebClient = botToken =>
      new WebClient(botToken, { retryConfig: { retries: 1 }, timeout: 10_000 }),
  ) {}

  async verify(botToken: string): Promise<SlackInstallationIdentity> {
    if (!botToken.startsWith("xoxb-")) throw new SlackIntegrationError("invalid_credentials", "请输入 Bot User OAuth Token（xoxb-…）。");
    try {
      const client = this.createClient(botToken);
      const response = await client.auth.test();
      if (!response.ok || !response.team_id || !response.user_id) {
        throw new SlackIntegrationError("invalid_credentials", "Slack 未返回完整的 App、Workspace 和 Bot 身份。");
      }
      let appId = response.app_id;
      let appName = response.app_name;
      if (!appId) {
        if (!response.bot_id) {
          throw new SlackIntegrationError("invalid_credentials", "Slack 未返回完整的 App、Workspace 和 Bot 身份。");
        }
        const botResponse = await client.bots.info({ bot: response.bot_id, team_id: response.team_id });
        if (!botResponse.ok || !botResponse.bot?.app_id) {
          throw new SlackIntegrationError("invalid_credentials", "Slack 未返回完整的 App、Workspace 和 Bot 身份。");
        }
        appId = botResponse.bot.app_id;
        appName ??= botResponse.bot.name;
      }
      return {
        appId,
        ...(appName ? { appName } : {}),
        teamId: response.team_id,
        ...(response.team ? { teamName: response.team } : {}),
        botUserId: response.user_id,
        ...(response.bot_id ? { botId: response.bot_id } : {}),
        ...(response.is_enterprise_install ? { enterpriseInstall: true } : {}),
      };
    } catch (error) {
      if (error instanceof SlackIntegrationError) throw error;
      throw new SlackIntegrationError("invalid_credentials", "Slack 无法验证这个 Bot Token，请检查 Token 和 App 安装状态。");
    }
  }
}

export class SlackIntegrationError extends Error {
  constructor(
    readonly code: "invalid_credentials" | "invalid_target" | "not_found",
    message: string,
  ) { super(message); }
}

export class SlackIntegrationManager {
  private readonly targetIds: ReadonlySet<string>;

  constructor(
    readonly repository: SlackInstallationRepository,
    private readonly baseUrl: string,
    readonly targets: readonly SlackConnectionTarget[],
    private readonly verifier: SlackTokenVerifier = new SlackWebApiTokenVerifier(),
  ) {
    this.targetIds = new Set(targets.map(target => target.agentId));
  }

  async list(tenantId: string): Promise<readonly SlackConnectionView[]> {
    return (await this.repository.list(tenantId)).map(record => this.view(record));
  }

  async get(tenantId: string, id: string): Promise<SlackConnectionView> {
    const record = await this.repository.get(tenantId, id);
    if (!record) throw new SlackIntegrationError("not_found", "Slack App connection was not found");
    return this.view(record);
  }

  async create(input: {
    tenantId: string;
    actorId: string;
    displayName: string;
    agentId: string;
    credentials: SlackAppCredentials;
    devRuntimeEnabled?: boolean;
  }): Promise<SlackConnectionView> {
    this.assertTarget(input.agentId);
    assertCredentials(input.credentials);
    const identity = await this.verifier.verify(input.credentials.botToken);
    return this.view(await this.repository.create({
      tenantId: input.tenantId,
      actorId: input.actorId,
      displayName: input.displayName.trim(),
      agentId: input.agentId,
      identity,
      ...(input.devRuntimeEnabled !== undefined ? { devRuntimeEnabled: input.devRuntimeEnabled } : {}),
      ...input.credentials,
    }));
  }

  async updateCredentials(input: {
    tenantId: string;
    actorId: string;
    id: string;
    revision: number;
    credentials: SlackAppCredentials;
    devRuntimeEnabled?: boolean;
  }): Promise<SlackConnectionView> {
    assertCredentials(input.credentials);
    const identity = await this.verifier.verify(input.credentials.botToken);
    return this.view(await this.repository.updateCredentials({
      tenantId: input.tenantId,
      actorId: input.actorId,
      id: input.id,
      expectedRevision: input.revision,
      identity,
      ...(input.devRuntimeEnabled !== undefined ? { devRuntimeEnabled: input.devRuntimeEnabled } : {}),
      ...input.credentials,
    }));
  }

  async rebind(input: { tenantId: string; actorId: string; id: string; revision: number; agentId: string }): Promise<SlackConnectionView> {
    this.assertTarget(input.agentId);
    return this.view(await this.repository.rebind(input.tenantId, input.id, input.agentId, input.revision, input.actorId));
  }

  async setDevRuntimeEnabled(input: { tenantId: string; actorId: string; id: string; revision: number; enabled: boolean }): Promise<SlackConnectionView> {
    return this.view(await this.repository.setDevRuntimeEnabled(
      input.tenantId,
      input.id,
      input.enabled,
      input.revision,
      input.actorId,
    ));
  }

  async setEnabled(input: { tenantId: string; actorId: string; id: string; revision: number; enabled: boolean }): Promise<SlackConnectionView> {
    return this.view(await this.repository.setEnabled(input.tenantId, input.id, input.enabled, input.revision, input.actorId));
  }

  async delete(input: { tenantId: string; actorId: string; id: string; revision: number }): Promise<void> {
    await this.repository.delete(input.tenantId, input.id, input.revision, input.actorId);
  }

  private assertTarget(agentId: string): void {
    if (!this.targetIds.has(agentId)) throw new SlackIntegrationError("invalid_target", "这个 Agent 尚未声明 Slack 绑定能力。");
  }

  private view(record: SlackInstallation): SlackConnectionView {
    return {
      ...record,
      webhookUrl: `${this.baseUrl.replace(/\/$/u, "")}/channels/slack/apps/${record.webhookId}/events`,
    };
  }
}

function assertCredentials(credentials: SlackAppCredentials): void {
  if (!credentials.botToken.trim() || !credentials.signingSecret.trim()) {
    throw new SlackIntegrationError("invalid_credentials", "Bot Token 和 Signing Secret 都是必填项。");
  }
  if (credentials.signingSecret.trim().length < 16) {
    throw new SlackIntegrationError("invalid_credentials", "Signing Secret 格式不正确。");
  }
}
