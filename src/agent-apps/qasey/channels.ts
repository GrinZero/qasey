import { createSlackAdapter } from "@chat-adapter/slack";
import type { ChannelConfig, ChannelHandler } from "@mastra/core/channels";
import { conversationScope } from "../../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../platform/context/schema.ts";
import { config } from "../../mastra/runtime.ts";

type NativeMessage = Parameters<ChannelHandler>[1];
type NativeThread = Parameters<ChannelHandler>[0];

export const qaseyChannels: ChannelConfig | undefined = createQaseyChannels();

function createQaseyChannels(): ChannelConfig | undefined {
  if (!config.SLACK_BOT_TOKEN) return undefined;
  if (!config.SLACK_SIGNING_SECRET && !config.SLACK_SOCKET_MODE_APP_TOKEN) return undefined;
  const adapter = createSlackAdapter({
    mode: config.SLACK_SIGNING_SECRET ? "webhook" : "socket",
    botToken: config.SLACK_BOT_TOKEN,
    ...(config.SLACK_SIGNING_SECRET ? { signingSecret: config.SLACK_SIGNING_SECRET } : {}),
    ...(config.SLACK_SOCKET_MODE_APP_TOKEN ? { appToken: config.SLACK_SOCKET_MODE_APP_TOKEN } : {}),
    ...(config.SLACK_BOT_USER_ID ? { botUserId: config.SLACK_BOT_USER_ID } : {}),
    nativeStreaming: true,
  });
  const handler: ChannelHandler = async (thread, message, defaultHandler, { requestContext }) => {
    const tenantId = slackTenantId(message);
    const scope = scopeFor(thread, message, tenantId);
    requestContext.set("requestId", `slack:${message.id}`);
    requestContext.set("applicationId", "qasey");
    requestContext.set("tenantId", tenantId);
    requestContext.set("userId", message.author.userId);
    requestContext.set("ingressSource", "mastra-channel:slack");
    requestContext.set("identity", {
      userId: message.author.userId,
      tenantId,
      roles: ["channel-user"],
      service: false,
    });
    requestContext.set("sessionId", scope.threadId);
    requestContext.set(MASTRA_RESOURCE_ID_KEY, scope.resourceId);
    requestContext.set(MASTRA_THREAD_ID_KEY, scope.threadId);
    await defaultHandler(thread, message);
  };
  return {
    adapters: {
      // The adapter and Mastra core use the same chat runtime; their generated
      // declaration files differ only in whether botUserId is optional.
      slack: { adapter: adapter as any, streaming: true, toolDisplay: "timeline", typingStatus: true },
    },
    handlers: {
      onDirectMessage: handler,
      onMention: handler,
      onSubscribedMessage: handler,
    },
    resolveResourceId: ({ thread, message }) => scopeFor(thread, message, slackTenantId(message)).resourceId,
    resolveThreadId: ({ thread, message }) => scopeFor(thread, message, slackTenantId(message)).threadId,
    chatOptions: {
      concurrency: { strategy: "queue", maxQueueSize: 10, onQueueFull: "drop-oldest", queueEntryTtlMs: 90_000 },
      dedupeTtlMs: 10 * 60_000,
    },
    inlineMedia: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
  };
}

function scopeFor(thread: NativeThread, message: NativeMessage, tenantId: string) {
  return conversationScope({
    applicationId: "qasey",
    tenantId,
    userId: message.author.userId,
    conversationId: thread.channelId,
    externalThreadId: message.threadId || thread.channelId,
    kind: thread.isDM ? "private" : "shared",
  });
}

function slackTenantId(message: NativeMessage): string {
  const raw = message.raw as Record<string, unknown> | undefined;
  const tenantId = stringValue(raw?.team_id) || stringValue(raw?.team)
    || stringValue((raw?.event as Record<string, unknown> | undefined)?.team);
  if (!tenantId) throw new Error("Verified Slack event is missing its workspace/team id");
  return tenantId;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
