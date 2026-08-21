import { createSlackAdapter } from "@chat-adapter/slack";
import type { ChannelConfig, ChannelHandler } from "@mastra/core/channels";
import { EntityType, SpanType } from "@mastra/core/observability";
import { resolveSlackChannelMode } from "../../../../packages/adapters/src/config.ts";
import { conversationScope } from "../../../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../../platform/context/schema.ts";
import { config } from "../../runtime.ts";
import { traceQaseyOperation } from "./observability.ts";
import { runQaseyTaskWorkflow } from "../../workflows/qasey-task-workflow.ts";
import { logError, logInfo } from "../../../../packages/adapters/src/index.ts";
import { slackCaseCompletionCards } from "./slack-case-delivery.ts";
import {
  markSlackRequestFinished,
  markSlackRequestStarted,
  showSlackStatus,
  SlackAgentStatusProjector,
} from "./slack-progress.ts";

type NativeMessage = Parameters<ChannelHandler>[1];
type NativeThread = Parameters<ChannelHandler>[0];

export const qaseyChannels: ChannelConfig | undefined = createQaseyChannels();

function createQaseyChannels(): ChannelConfig | undefined {
  if (!config.SLACK_BOT_TOKEN) return undefined;
  const mode = resolveSlackChannelMode(config);
  if (!mode) return undefined;
  const adapter = createSlackAdapter({
    mode,
    botToken: config.SLACK_BOT_TOKEN,
    ...(mode === "webhook" ? { signingSecret: config.SLACK_SIGNING_SECRET! } : {}),
    ...(mode === "socket" ? { appToken: config.SLACK_SOCKET_MODE_APP_TOKEN! } : {}),
    ...(config.SLACK_BOT_USER_ID ? { botUserId: config.SLACK_BOT_USER_ID } : {}),
    nativeStreaming: true,
  });
  const handler: ChannelHandler = async (thread, message, _defaultHandler, { requestContext, mastra }) => {
    if (!mastra) throw new Error("Mastra runtime is required for the Qasey Slack workflow");
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
    const context = {
      requestId: `slack:${message.id}`,
      channel: "slack" as const,
      sessionId: scope.threadId,
      chatInput: message.text,
      actor: {
        id: message.author.userId,
        ...(message.author.fullName ? { displayName: message.author.fullName } : {}),
        tenantId,
      },
      source: { channelId: thread.channelId, threadTs: message.threadId || thread.channelId },
      attachments: message.attachments.flatMap((attachment, index) => {
        if (!attachment.url || !attachment.mimeType) return [];
        return [{
          id: `${message.id}:${index}`,
          name: attachment.name || `attachment-${index + 1}`,
          mimeType: attachment.mimeType,
          url: attachment.url,
          source: "slack" as const,
        }];
      }),
    };
    const sourceMessage = thread.createSentMessageFromMessage(message);
    const receivedAt = Date.now();
    const slackRequestSpan = mastra.observability.getDefaultInstance()?.startSpan({
      type: SpanType.GENERIC,
      name: "qasey slack request",
      entityType: EntityType.AGENT,
      entityId: "qasey",
      entityName: "Qasey",
      input: {
        message: context.chatInput,
        channelId: thread.channelId,
        threadId: scope.threadId,
        attachmentCount: context.attachments.length,
      },
      metadata: {
        requestId: context.requestId,
        channel: "slack",
        actorId: context.actor.id,
      },
      requestContext,
      tags: ["qasey", "channel:slack", "ingress:channel"],
    });
    let firstToolAt: number | undefined;
    let firstProgressAt: number | undefined;
    let lastStatus: string | undefined;
    const statusProjector = new SlackAgentStatusProjector();
    const updateStatus = async (status: string | undefined) => {
      if (!status || status === lastStatus) return;
      lastStatus = status;
      await traceQaseyOperation(
        slackRequestSpan,
        "qasey slack status delivery",
        { status },
        () => showSlackStatus(thread, status),
      );
    };
    await traceQaseyOperation(
      slackRequestSpan,
      "qasey slack acknowledgement",
      {},
      () => markSlackRequestStarted(sourceMessage),
    );
    let outcome: "success" | "failure" = "failure";
    let requestError: unknown;
    try {
      const result = await runQaseyTaskWorkflow(mastra, context, {
        requestContext,
        ...(slackRequestSpan ? { tracingContext: { currentSpan: slackRequestSpan } } : {}),
        events: {
          onPhase: async ({ runId, phase }) => {
            logInfo("slack.request.phase", {
              requestId: context.requestId,
              runId,
              phase,
              elapsedMs: Date.now() - receivedAt,
            });
          },
          onToolStart: async ({ runId, toolName }) => {
            const first = firstToolAt === undefined;
            firstToolAt ??= Date.now();
            logInfo("slack.request.tool_started", {
              requestId: context.requestId,
              runId,
              toolName,
              elapsedMs: Date.now() - receivedAt,
              first,
            });
          },
          onAgentRuntimeEvent: async event => {
            await updateStatus(statusProjector.project(event));
            logInfo("slack.request.agent_event", {
              requestId: context.requestId,
              runId: event.runId,
              eventType: event.type,
              step: event.step,
              elapsedMs: Date.now() - receivedAt,
            });
          },
          onAgentProgress: async report => {
            firstProgressAt ??= Date.now();
            await thread.post({ markdown: `*${report.title}*\n${report.detail}${report.next ? `\n下一步：${report.next}` : ""}` });
            logInfo("slack.request.progress_delivered", {
              requestId: context.requestId,
              milestone: report.milestone,
              sequence: report.sequence,
              elapsedMs: Date.now() - receivedAt,
            });
          },
        },
      });
      const completionCards = slackCaseCompletionCards(result.completionReceipt, {
        baseUrl: config.METERSPHERE_BASE_URL,
        projectId: config.METERSPHERE_PROJECT_ID,
      });
      await traceQaseyOperation(
        slackRequestSpan,
        "qasey slack final delivery",
        { completionCardCount: completionCards.length, finalization: result.finalization },
        async () => {
          if (completionCards.length > 0) {
            try {
              for (const card of completionCards) await thread.post(card);
            } catch (error) {
              logError("slack.case_table_delivery_failed", error, { requestId: context.requestId });
              await thread.post({ markdown: result.text });
            }
          } else {
            await thread.post({ markdown: result.text });
          }
        },
      );
      outcome = "success";
    } catch (error) {
      requestError = error;
      const detail = config.NODE_ENV === "production" ? "请稍后重试，或联系维护者并提供当前消息链接。" : error instanceof Error ? error.message : String(error);
      await traceQaseyOperation(
        slackRequestSpan,
        "qasey slack failure delivery",
        {},
        () => thread.post(`Qasey 未能完成这次任务。${detail}`).then(() => undefined),
      );
    } finally {
      await traceQaseyOperation(
        slackRequestSpan,
        "qasey slack completion reaction",
        { outcome },
        () => markSlackRequestFinished(sourceMessage, outcome),
      );
      const durationMs = Date.now() - receivedAt;
      logInfo("slack.request.finished", {
        requestId: context.requestId,
        outcome,
        durationMs,
        timeToFirstToolMs: firstToolAt ? firstToolAt - receivedAt : undefined,
        timeToFirstProgressMs: firstProgressAt ? firstProgressAt - receivedAt : undefined,
      });
      if (requestError) {
        slackRequestSpan?.error({
          error: requestError instanceof Error ? requestError : new Error(String(requestError)),
          endSpan: true,
          metadata: { outcome, durationMs },
        });
      } else {
        slackRequestSpan?.end({ metadata: { outcome, durationMs } });
      }
    }
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
