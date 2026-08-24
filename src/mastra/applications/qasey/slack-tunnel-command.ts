import type { AgentChannels } from "@mastra/core/channels";
import type { Mastra } from "@mastra/core/mastra";
import { devRuntimeTunnelServerEnabled } from "../../../../packages/adapters/src/config.ts";
import { DEFAULT_SLACK_DEV_RUNTIME_COMMAND } from "../../../platform/channels/slack-dev-runtime.ts";
import { config } from "../../runtime.ts";
import { DevRuntimeTunnelError, getDevRuntimeTunnelService } from "./dev-runtime-service.ts";

const registered = new WeakSet<object>();
export const QASEY_LOCAL_SLASH_COMMAND_SETUP = {
  command: DEFAULT_SLACK_DEV_RUNTIME_COMMAND,
  description: "绑定本地 Qasey Runtime",
  usageHint: "bind <runtime-id> | unbind | status",
  requiredScope: "commands",
} as const;
function help(command: string): string {
  return [
    "*Qasey 本地 Runtime*",
    `\`${command} bind local-XXXXXXXX\` 绑定当前本地 Runtime`,
    `\`${command} unbind\` 恢复 testing 云端执行`,
    `\`${command} status\` 查看当前绑定`,
  ].join("\n");
}

export async function registerQaseySlackTunnelCommand(
  mastra: Mastra,
  suppliedChannels?: AgentChannels,
  command: string = QASEY_LOCAL_SLASH_COMMAND_SETUP.command,
): Promise<void> {
  if (!devRuntimeTunnelServerEnabled(config)) return;
  // File-based agents are injected by Mastra's generated entry only after this
  // source entry has finished evaluating. Do not call getAgent() synchronously
  // here: a top-level caller would prevent the generated entry from ever
  // reaching __registerFsAgents().
  let channels = suppliedChannels;
  for (let attempt = 0; !channels && attempt < 200; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const agent = mastra.listAgents()["qasey-main"];
    channels = agent?.getChannels() ?? undefined;
  }
  if (!channels) {
    if (!mastra.listAgents()["qasey-main"]) {
      throw new Error(`qasey-main did not register in time for ${command}`);
    }
    // A provider-managed Slack App may be the only Slack ingress. In that case
    // the bridge callback will register the command when the installation loads.
    return;
  }
  if (registered.has(channels)) return;
  let sdk = channels.sdk;
  for (let attempt = 0; !sdk && attempt < 200; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    sdk = channels.sdk;
  }
  if (!sdk) throw new Error(`Qasey Slack SDK did not initialize in time for ${command}`);
  registered.add(channels);
  sdk.onSlashCommand(command, async event => {
    const raw = event.raw as Record<string, unknown> | undefined;
    const workspaceId = stringValue(raw?.team_id) || stringValue(raw?.enterprise_id);
    const slackUserId = event.user.userId || stringValue(raw?.user_id);
    const reply = (message: string) => event.channel.postEphemeral(event.user, { markdown: message }, { fallbackToDM: false });
    if (!workspaceId || !slackUserId) {
      await reply("无法从已验签的 Slash Command 中识别 Workspace 或用户。");
      return;
    }
    const [subcommand = "help", argument, ...extra] = event.text.trim().split(/\s+/u);
    const service = getDevRuntimeTunnelService(mastra);
    try {
      if (subcommand === "bind" && argument && extra.length === 0) {
        const binding = await service.bind(workspaceId, slackUserId, argument);
        await reply(`已绑定 *${binding.runtimeId}*，有效期至 ${formatSlackTime(binding.expiresAt)}。\n后续 @Qasey、DM 和线程消息将由该本地 Runtime 执行。`);
        return;
      }
      if (subcommand === "unbind" && !argument) {
        const removed = await service.unbind(workspaceId, slackUserId);
        await reply(removed ? "已解除本地 Runtime 绑定，后续消息由 *testing-cloud* 执行。" : "当前没有本地 Runtime 绑定。");
        return;
      }
      if (subcommand === "status" && !argument) {
        const binding = await service.bindingFor(workspaceId, slackUserId);
        if (!binding) await reply("当前没有本地 Runtime 绑定，消息由 *testing-cloud* 执行。");
        else await reply([
          `Runtime：*${binding.runtimeId}*`,
          `状态：${binding.online ? "在线" : "离线（不会自动回退云端）"}`,
          `过期：${formatSlackTime(binding.expiresAt)}`,
        ].join("\n"));
        return;
      }
      await reply(help(command));
    } catch (error) {
      const message = error instanceof DevRuntimeTunnelError
        ? error.message
        : "本地 Runtime 注册表暂时不可用，请稍后重试。";
      await reply(`操作失败：${message}`);
    }
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatSlackTime(value: string): string {
  return `<!date^${Math.floor(Date.parse(value) / 1_000)}^{date_short_pretty} {time}|${value}>`;
}
