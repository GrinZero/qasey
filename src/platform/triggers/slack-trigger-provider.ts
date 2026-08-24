import type { SlackConnectionView, SlackIntegrationManager } from "../channels/slack-integration-manager.ts";
import { SlackIntegrationError } from "../channels/slack-integration-manager.ts";
import { normalizeSlackDevRuntimeCommand } from "../channels/slack-dev-runtime.ts";
import { SlackInstallationRepositoryError } from "../channels/slack-installation-repository.ts";
import type {
  PlatformTriggerProvider,
  TriggerConnection,
  TriggerProviderManifest,
  TriggerTarget,
} from "./trigger-provider-registry.ts";
import { TriggerProviderError } from "./trigger-provider-registry.ts";

const baseManifest: TriggerProviderManifest = {
  id: "slack",
  name: "Slack",
  description: "用 Slack 消息、提及和交互事件触发 Agent。",
  category: "channel",
  configurationTitle: "连接 Slack App",
  configurationDescription: "使用已经安装到 Workspace 的 App；系统不会自动创建 App。",
  fields: [
    { key: "botToken", label: "Bot User OAuth Token", type: "secret", required: true, placeholder: "xoxb-…" },
    {
      key: "signingSecret", label: "Signing Secret", type: "secret", required: true,
      placeholder: "Slack Basic Information 中的 Signing Secret",
    },
  ],
  capabilities: { configurationUpdate: true, enableDisable: true, rebind: true, delete: true },
};

export interface SlackTriggerProviderOptions {
  slashCommand?: {
    command: string;
    description: string;
    usageHint: string;
    requiredScope: string;
  };
}

export class SlackTriggerProvider implements PlatformTriggerProvider {
  readonly manifest: TriggerProviderManifest;

  constructor(
    private readonly integrations: SlackIntegrationManager,
    private readonly onChanged?: (installationId: string) => void,
    private readonly options: SlackTriggerProviderOptions = {},
  ) {
    this.manifest = this.options.slashCommand ? {
      ...baseManifest,
      fields: [...baseManifest.fields, {
        key: "devRuntimeEnabled",
        label: "启用本地 Runtime 开发隧道",
        type: "boolean",
        required: false,
        help: "仅用于 testing。启用后，这个 Slack App 会处理下面配置的 Slash Command，并按用户绑定路由到本地 Runtime。",
      }, {
        key: "devRuntimeCommand",
        label: "本地 Runtime Slash Command",
        type: "text",
        required: false,
        placeholder: this.options.slashCommand.command,
        help: `在 Slack App 后台创建该 Command；留空时使用 ${this.options.slashCommand.command}。`,
      }],
    } : baseManifest;
  }

  async targets(_tenantId: string): Promise<readonly TriggerTarget[]> {
    return this.integrations.targets.map(target => ({
      id: targetId(target.agentId),
      applicationId: target.applicationId,
      kind: "agent",
      resourceId: target.agentId,
      name: target.name,
    }));
  }

  async list(tenantId: string): Promise<readonly TriggerConnection[]> {
    return (await translate(() => this.integrations.list(tenantId))).map(connection => this.connection(connection));
  }

  async create(input: {
    tenantId: string; actorId: string; displayName: string; targetId: string;
    configuration: Readonly<Record<string, string>>;
  }): Promise<TriggerConnection> {
    const target = this.requireTarget(input.targetId);
    const connection = await translate(() => this.integrations.create({
      tenantId: input.tenantId,
      actorId: input.actorId,
      displayName: input.displayName,
      agentId: target.resourceId,
      credentials: credentials(input.configuration),
      devRuntimeEnabled: this.options.slashCommand
        ? booleanValue(input.configuration.devRuntimeEnabled)
        : false,
      ...(this.options.slashCommand ? {
        devRuntimeCommand: slashCommandValue(input.configuration.devRuntimeCommand, this.options.slashCommand.command),
      } : {}),
    }));
    return this.connection(connection);
  }

  async updateConfiguration(input: {
    tenantId: string; actorId: string; id: string; revision: number;
    configuration: Readonly<Record<string, string>>;
  }): Promise<TriggerConnection> {
    const devRuntimeEnabled = optionalBooleanValue(input.configuration.devRuntimeEnabled);
    const devRuntimeCommand = this.options.slashCommand
      ? optionalSlashCommandValue(input.configuration.devRuntimeCommand, this.options.slashCommand.command)
      : undefined;
    const configuredCredentials = credentials(input.configuration);
    const hasCredentialInput = Boolean(configuredCredentials.botToken || configuredCredentials.signingSecret);
    const connection = await translate(() => this.options.slashCommand
      && (devRuntimeEnabled !== undefined || devRuntimeCommand !== undefined)
      && !hasCredentialInput
      ? this.integrations.setDevRuntimeConfiguration({
          tenantId: input.tenantId,
          actorId: input.actorId,
          id: input.id,
          revision: input.revision,
          ...(devRuntimeEnabled !== undefined ? { enabled: devRuntimeEnabled } : {}),
          ...(devRuntimeCommand !== undefined ? { command: devRuntimeCommand } : {}),
        })
      : this.integrations.updateCredentials({
          tenantId: input.tenantId, actorId: input.actorId, id: input.id, revision: input.revision,
          credentials: configuredCredentials,
          ...(this.options.slashCommand && devRuntimeEnabled !== undefined ? { devRuntimeEnabled } : {}),
          ...(this.options.slashCommand && devRuntimeCommand !== undefined ? { devRuntimeCommand } : {}),
        }));
    this.onChanged?.(connection.id);
    return this.connection(connection);
  }

  async rebind(input: {
    tenantId: string; actorId: string; id: string; revision: number; targetId: string;
  }): Promise<TriggerConnection> {
    const target = this.requireTarget(input.targetId);
    const connection = await translate(() => this.integrations.rebind({
      tenantId: input.tenantId, actorId: input.actorId, id: input.id, revision: input.revision,
      agentId: target.resourceId,
    }));
    this.onChanged?.(connection.id);
    return this.connection(connection);
  }

  async setEnabled(input: {
    tenantId: string; actorId: string; id: string; revision: number; enabled: boolean;
  }): Promise<TriggerConnection> {
    const connection = await translate(() => this.integrations.setEnabled(input));
    this.onChanged?.(connection.id);
    return this.connection(connection);
  }

  async delete(input: { tenantId: string; actorId: string; id: string; revision: number }): Promise<void> {
    await translate(() => this.integrations.delete(input));
    this.onChanged?.(input.id);
  }

  private requireTarget(id: string): TriggerTarget {
    const agentId = id.startsWith("agent:") ? id.slice("agent:".length) : "";
    const target = this.integrations.targets.find(candidate => candidate.agentId === agentId);
    if (!target) throw new TriggerProviderError("invalid_target", "这个目标尚未声明 Slack Trigger 能力。");
    return { id, applicationId: target.applicationId, kind: "agent", resourceId: target.agentId, name: target.name };
  }

  private connection(connection: SlackConnectionView): TriggerConnection {
    const configuredTarget = this.integrations.targets.find(candidate => candidate.agentId === connection.agentId);
    const target: TriggerTarget = configuredTarget
      ? {
          id: targetId(configuredTarget.agentId), applicationId: configuredTarget.applicationId,
          kind: "agent", resourceId: configuredTarget.agentId, name: configuredTarget.name,
        }
      : {
          id: targetId(connection.agentId), applicationId: "unknown",
          kind: "agent", resourceId: connection.agentId, name: connection.agentId,
        };
    const localRuntimeDetail = this.options.slashCommand
      ? ` 本地 Runtime 开发隧道已${connection.devRuntimeEnabled ? "启用" : "关闭"}。`
      : "";
    const statusDetail = (connection.status === "awaiting_webhook"
      ? "把 Webhook URL 填入 Slack，验证成功后自动启用。"
      : connection.status === "active"
        ? "Slack 事件会发送给当前绑定目标。"
        : connection.status === "disabled"
          ? "入口地址会保留，但新事件不会进入绑定目标。"
          : "运行时连接失败，请检查配置或重新保存。") + localRuntimeDetail;
    return {
      id: connection.id,
      providerId: this.manifest.id,
      providerName: this.manifest.name,
      displayName: connection.displayName,
      status: connection.status,
      statusDetail,
      revision: connection.revision,
      target,
      identity: {
        label: "Slack identity",
        value: connection.identity.botUserId,
        context: `${connection.identity.teamName ?? connection.identity.teamId} · ${connection.identity.appId}`,
      },
      endpoint: { label: "Event Subscriptions / Interactivity URL", url: connection.webhookUrl },
      ...(this.options.slashCommand ? {
        configurationValues: {
          devRuntimeEnabled: String(connection.devRuntimeEnabled),
          devRuntimeCommand: connection.devRuntimeCommand,
        },
      } : {}),
      ...(this.options.slashCommand && connection.devRuntimeEnabled ? {
        setupFields: [
          { key: "slash-command", label: "Slash Command", value: connection.devRuntimeCommand, copyable: true },
          { key: "slash-command-request-url", label: "Request URL", value: connection.webhookUrl, copyable: true },
          { key: "slash-command-description", label: "Short Description", value: this.options.slashCommand.description },
          { key: "slash-command-usage-hint", label: "Usage Hint", value: this.options.slashCommand.usageHint, copyable: true },
          { key: "slash-command-scope", label: "Required Bot Scope", value: this.options.slashCommand.requiredScope, copyable: true },
        ],
      } : {}),
      ...(connection.status === "awaiting_webhook" ? {
        guidance: {
          title: "等待 Slack 验证",
          body: this.options.slashCommand && connection.devRuntimeEnabled
            ? "启用 Event Subscriptions；同一个入口也用于 Interactivity 和 Slash Command。"
            : "在 Slack App 设置中启用 Event Subscriptions；同一个 URL 也用于 Interactivity。",
          codes: ["app_mention", "message.im"],
        },
      } : {}),
      lastVerifiedAt: connection.lastTokenVerifiedAt,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }
}

function targetId(agentId: string): string { return `agent:${agentId}`; }

function credentials(configuration: Readonly<Record<string, string>>) {
  return {
    botToken: configuration.botToken?.trim() ?? "",
    signingSecret: configuration.signingSecret?.trim() ?? "",
  };
}

function optionalBooleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return booleanValue(value);
}

function booleanValue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function optionalSlashCommandValue(value: string | undefined, fallback: string): string | undefined {
  return value === undefined ? undefined : slashCommandValue(value, fallback);
}

function slashCommandValue(value: string | undefined, fallback: string): string {
  try {
    return normalizeSlackDevRuntimeCommand(value, fallback);
  } catch (error) {
    throw new TriggerProviderError(
      "invalid_configuration",
      error instanceof Error ? error.message : "Slash Command 格式不正确。",
    );
  }
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof TriggerProviderError) throw error;
    if (error instanceof SlackInstallationRepositoryError) {
      throw new TriggerProviderError(
        error.code === "not_found" ? "not_found" : "conflict",
        error.message,
      );
    }
    if (error instanceof SlackIntegrationError) {
      throw new TriggerProviderError(
        error.code === "not_found" ? "not_found"
          : error.code === "invalid_target" ? "invalid_target"
            : "invalid_configuration",
        error.message,
      );
    }
    throw error;
  }
}
