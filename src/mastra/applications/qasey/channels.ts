import { createSlackAdapter, type SlackBotToken } from "@chat-adapter/slack";
import type { ChannelConfig, ChannelHandler } from "@mastra/core/channels";
import { EntityType, SpanType } from "@mastra/core/observability";
import { resolveSlackChannelMode } from "../../../../packages/adapters/src/config.ts";
import { devRuntimeTunnelServerEnabled } from "../../../../packages/adapters/src/config.ts";
import { conversationScope } from "../../../platform/context/conversation-scope.ts";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "../../../platform/context/schema.ts";
import { config } from "../../runtime.ts";
import { traceQaseyOperation } from "./observability.ts";
import { executeQasey, QaseyResponseSchema } from "./service.ts";
import { logError, logInfo } from "../../../../packages/adapters/src/index.ts";
import {
  markSlackRequestFinished,
  markSlackRequestStarted,
  showSlackStatus,
  SlackAgentStatusProjector,
} from "./slack-progress.ts";
import { DevRuntimeTunnelError, getDevRuntimeTunnelService } from "./dev-runtime-service.ts";
import { slackTunnelApprovalCard, slackTunnelApprovalStatusCard } from "./slack-tunnel-delivery.ts";
import type { QaseyAgentRuntimeEvent, QaseyResponse } from "./service.ts";
import { createDatadogTraceCarrier } from "../../instrumentation.ts";
import {
  createRedisSlackIngressState,
  slackDeliveryId,
  SlackIngressRetryableError,
  type SlackDeliveryClaim,
  type SlackIngressStateAdapter,
} from "../../../platform/channels/slack-ingress-state.ts";
import { productionSignals } from "../../../platform/observability/production-signals.ts";

type NativeMessage = Parameters<ChannelHandler>[1];
type NativeThread = Parameters<ChannelHandler>[0];

export const qaseyChannels: ChannelConfig | undefined = createQaseyChannels();

function createQaseyChannels(): ChannelConfig | undefined {
  if (!config.SLACK_BOT_TOKEN) return undefined;
  const mode = resolveSlackChannelMode(config);
  if (!mode) return undefined;
  return createQaseySlackChannelConfig({
    mode,
    botToken: config.SLACK_BOT_TOKEN,
    ...(mode === "webhook" ? { signingSecret: config.SLACK_SIGNING_SECRET! } : {}),
    ...(mode === "socket" ? { appToken: config.SLACK_SOCKET_MODE_APP_TOKEN! } : {}),
    ...(config.SLACK_BOT_USER_ID ? { botUserId: config.SLACK_BOT_USER_ID } : {}),
  });
}

export interface QaseySlackChannelOptions {
  mode?: "webhook" | "socket";
  botToken: SlackBotToken;
  signingSecret?: string;
  appToken?: string;
  botUserId?: string;
  /** Platform tenant that owns a UI-managed Slack installation. */
  tenantId?: string;
  /** Stable installation id used to isolate memory across Slack Apps. */
  installationId?: string;
  /** Signed Slack team id used for local Runtime bindings. */
  slackWorkspaceId?: string;
  /** Installation-level opt-in for the testing Local Runtime tunnel. */
  devRuntimeTunnelEnabled?: boolean;
  /** Shared ingress state override for focused tests and embedding hosts. */
  ingressState?: SlackIngressStateAdapter;
}

/** Build one isolated Slack bot identity while sharing Qasey's domain behavior. */
export function createQaseySlackChannelConfig(options: QaseySlackChannelOptions): ChannelConfig {
  const mode = options.mode ?? "webhook";
  const ingressState = options.ingressState ?? createDistributedSlackIngressState(options.installationId, options.tenantId);
  const adapter = createSlackAdapter({
    mode,
    botToken: options.botToken,
    ...(mode === "webhook" && options.signingSecret ? { signingSecret: options.signingSecret } : {}),
    ...(mode === "socket" && options.appToken ? { appToken: options.appToken } : {}),
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
    nativeStreaming: true,
  });
  const handler: ChannelHandler = async (thread, message, _defaultHandler, { requestContext, mastra }) => {
    if (!mastra) throw new Error("Mastra runtime is required for the Qasey Slack workflow");
    const tenantId = options.tenantId ?? slackTenantId(message);
    const workspaceId = options.slackWorkspaceId ?? slackTenantId(message);
    const deliveryId = slackDeliveryId({
      ...(options.installationId ? { installationId: options.installationId } : {}),
      workspaceId,
      messageId: message.id,
    });
    let deliveryClaim: SlackDeliveryClaim | undefined;
    if (ingressState) {
      const admission = await ingressState.claimDelivery(deliveryId, message.id);
      if (admission.status === "duplicate") return;
      if (admission.status === "in-flight") {
        throw new SlackIngressRetryableError(
          `Slack delivery ${deliveryId} is already owned by another replica`,
          "SLACK_INGRESS_BUSY",
          deliveryId,
          admission.retryAfterMs,
        );
      }
      deliveryClaim = admission.claim;
    }
    const scope = scopeFor(thread, message, tenantId, options.installationId);
    requestContext.set("requestId", `slack:${message.id}`);
    requestContext.set("applicationId", "qasey");
    requestContext.set("tenantId", tenantId);
    requestContext.set("userId", message.author.userId);
    requestContext.set("ingressSource", "mastra-channel:slack");
    if (options.installationId) requestContext.set("integrationId", options.installationId);
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
      chatInput: buildSlackChatInput(message.text, message.links),
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
      type: SpanType.WORKFLOW_RUN,
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
        sessionId: context.sessionId,
        userId: context.actor.id,
        channel: "slack",
        actorId: context.actor.id,
      },
      requestContext,
      tags: ["qasey", "channel:slack", "ingress:channel"],
    });
    let firstToolAt: number | undefined;
    let firstProgressAt: number | undefined;
    let lastStatus: string | undefined;
    let statusDeliveryCount = 0;
    let statusDeliveryFailureCount = 0;
    let statusDeliveryDurationMs = 0;
    let firstStatusDeliveryAt: number | undefined;
    const statusProjector = new SlackAgentStatusProjector();
    const updateStatus = async (status: string | undefined) => {
      if (!status || status === lastStatus) return;
      lastStatus = status;
      const startedAt = Date.now();
      statusDeliveryCount += 1;
      firstStatusDeliveryAt ??= startedAt;
      try {
        await showSlackStatus(thread, status);
      } catch (error) {
        statusDeliveryFailureCount += 1;
        throw error;
      } finally {
        statusDeliveryDurationMs += Date.now() - startedAt;
      }
    };
    await traceQaseyOperation(
      slackRequestSpan,
      "qasey slack acknowledgement",
      {},
      () => markSlackRequestStarted(sourceMessage),
    );
    let outcome: "success" | "failure" = "failure";
    let requestError: unknown;
    const tunnelAvailable = devRuntimeTunnelServerEnabled(config);
    const tunnelEnabled = tunnelAvailable
      && (!options.installationId || options.devRuntimeTunnelEnabled === true);
    // Only expose an execution source after this request has matched a local Runtime binding.
    let executionSource: string | undefined;
    const tunnel = tunnelEnabled
      ? getDevRuntimeTunnelService(mastra)
      : undefined;
    const pendingApprovalIds: string[] = [];
    try {
      const onPhase = async ({ runId, phase }: { runId: string; phase: "agent" | "workflow" | "finalizing" }) => {
        logInfo("slack.request.phase", {
          requestId: context.requestId,
          runId,
          phase,
          elapsedMs: Date.now() - receivedAt,
        });
      };
      const onToolStart = async ({ runId, toolName }: { runId: string; toolName: string }) => {
        const first = firstToolAt === undefined;
        firstToolAt ??= Date.now();
        logInfo("slack.request.tool_started", {
          requestId: context.requestId,
          runId,
          toolName,
          elapsedMs: Date.now() - receivedAt,
          first,
        });
      };
      const onAgentRuntimeEvent = async (event: QaseyAgentRuntimeEvent) => {
        await updateStatus(statusProjector.project(event));
        logInfo("slack.request.agent_event", {
          requestId: context.requestId,
          runId: event.runId,
          eventType: event.type,
          step: event.step,
          elapsedMs: Date.now() - receivedAt,
        });
      };
      const onAgentProgress = async (report: {
        runId?: string;
        milestone: string;
        title: string;
        detail: string;
        next?: string | undefined;
        sequence: number;
      }) => {
        firstProgressAt ??= Date.now();
        await thread.post({ markdown: `*${report.title}*\n${report.detail}${report.next ? `\n下一步：${report.next}` : ""}` });
        logInfo("slack.request.progress_delivered", {
          requestId: context.requestId,
          milestone: report.milestone,
          sequence: report.sequence,
          elapsedMs: Date.now() - receivedAt,
        });
      };

      const binding = tunnel ? await tunnel.bindingFor(workspaceId, message.author.userId) : undefined;
      let result: QaseyResponse;
      if (binding?.online) {
        executionSource = binding.runtimeId;
        const jobId = crypto.randomUUID();
        const deadlineAt = new Date(Date.now() + config.QASEY_AGENT_TIMEOUT_MS).toISOString();
        result = QaseyResponseSchema.parse(await tunnel!.runRemoteJob({
          type: "job",
          jobId,
          runtimeId: binding.runtimeId,
          deadlineAt,
          context,
          resourceId: scope.resourceId,
          threadId: scope.threadId,
          ...(slackRequestSpan ? {
            trace: {
              traceId: slackRequestSpan.traceId,
              parentSpanId: slackRequestSpan.id,
              carrier: createDatadogTraceCarrier(slackRequestSpan.id, slackRequestSpan.traceId),
            },
          } : {}),
          delivery: {
            workspaceId,
            ...(options.installationId ? { installationId: options.installationId } : {}),
          },
        }, {
          onPhase: event => onPhase(event),
          onToolStarted: event => onToolStart(event),
          onAgentRuntimeEvent: event => onAgentRuntimeEvent(event.event),
          onProgress: event => onAgentProgress(event.report),
          onApprovalRequested: async event => {
            const approval = await tunnel!.createApproval({
              approvalId: event.approvalId,
              jobId,
              runtimeId: binding.runtimeId,
              workspaceId,
              slackUserId: message.author.userId,
              toolName: event.toolName,
              argsSummary: event.argsSummary,
              argsHash: event.argsHash,
              deadlineAt,
            });
            const callbackUrl = new URL(`/v1/dev-runtime-approvals/${encodeURIComponent(event.approvalId)}`, config.QASEY_PUBLIC_BASE_URL);
            callbackUrl.searchParams.set("token", approval.token);
            const sent = await thread.post(slackTunnelApprovalCard({
              toolName: event.toolName,
              argsSummary: event.argsSummary,
              callbackUrl: callbackUrl.toString(),
              runtimeId: binding.runtimeId,
            }));
            await tunnel!.attachApprovalMessage(event.approvalId, thread.id, sent.id);
            pendingApprovalIds.push(event.approvalId);
          },
        })) as QaseyResponse;
      } else {
        result = await executeQasey(mastra, context, {
          requestContext,
          ...(slackRequestSpan ? { tracingContext: { currentSpan: slackRequestSpan } } : {}),
          events: {
            onPhase,
            onToolStart,
            onAgentRuntimeEvent,
            onAgentProgress,
          },
        });
      }
      const completionCards: never[] = [];
      const sourceFooter = executionSource ? `\n\n_运行环境：${executionSource}_` : "";
      const finalText = `${result.text}${sourceFooter}`;
      await traceQaseyOperation(
        slackRequestSpan,
        "qasey slack final delivery",
        { completionCardCount: completionCards.length, finalization: result.finalization },
        async () => {
          if (completionCards.length > 0) {
            try {
              for (const card of completionCards) await thread.post(card);
              if (sourceFooter) await thread.post({ markdown: sourceFooter.trim() });
            } catch (error) {
              logError("slack.case_table_delivery_failed", error, { requestId: context.requestId });
              await thread.post({ markdown: finalText });
            }
          } else {
            await thread.post({ markdown: finalText });
          }
        },
      );
      if (deliveryClaim && ingressState && !await ingressState.ackDelivery(deliveryClaim)) {
        throw new SlackIngressRetryableError(
          `Slack delivery ${deliveryId} lost ownership before acknowledgement`,
          "SLACK_INGRESS_BUSY",
          deliveryId,
        );
      }
      outcome = "success";
    } catch (error) {
      requestError = error;
      if (deliveryClaim && ingressState) {
        try {
          await ingressState.retryDelivery(deliveryClaim);
        } catch (retryError) {
          logError("slack.ingress.retry_release_failed", retryError, { deliveryId });
        }
      }
      if (tunnel && pendingApprovalIds.length > 0) {
        const status = error instanceof DevRuntimeTunnelError && error.code === "runtime_disconnected"
          ? "runtime_disconnected" as const
          : "expired" as const;
        for (const approvalId of pendingApprovalIds) {
          try {
            const record = await tunnel.expireApproval(approvalId);
            if (record?.threadId && record.messageId) {
              await thread.adapter.editMessage(
                record.threadId,
                record.messageId,
                slackTunnelApprovalStatusCard(record, status),
              );
            }
          } catch (approvalError) {
            logError("slack.tunnel_approval_finalize_failed", approvalError, { requestId: context.requestId, approvalId });
          }
        }
      }
      const detail = error instanceof DevRuntimeTunnelError
        ? error.message
        : config.NODE_ENV === "production"
          ? "请稍后重试，或联系维护者并提供当前消息链接。"
          : error instanceof Error ? error.message : String(error);
      const sourceFooter = executionSource ? `\n运行环境：${executionSource}` : "";
      await traceQaseyOperation(
        slackRequestSpan,
        "qasey slack failure delivery",
        {},
        () => thread.post(`Qasey 未能完成这次任务。${detail}${sourceFooter}`).then(() => undefined),
      );
    } finally {
      await traceQaseyOperation(
        slackRequestSpan,
        "qasey slack completion reaction",
        { outcome },
        () => markSlackRequestFinished(sourceMessage, outcome),
      );
      const durationMs = Date.now() - receivedAt;
      const deliveryMetadata = {
        outcome,
        durationMs,
        statusDeliveryCount,
        statusDeliveryFailureCount,
        statusDeliveryDurationMs,
        ...(firstStatusDeliveryAt ? { firstStatusDeliveryLatencyMs: firstStatusDeliveryAt - receivedAt } : {}),
      };
      logInfo("slack.request.finished", {
        requestId: context.requestId,
        workspaceId,
        slackUserId: message.author.userId,
        executionSource,
        outcome,
        durationMs,
        timeToFirstToolMs: firstToolAt ? firstToolAt - receivedAt : undefined,
        timeToFirstProgressMs: firstProgressAt ? firstProgressAt - receivedAt : undefined,
      });
      if (requestError) {
        slackRequestSpan?.error({
          error: requestError instanceof Error ? requestError : new Error(String(requestError)),
          endSpan: true,
          metadata: deliveryMetadata,
        });
      } else {
        slackRequestSpan?.end({ metadata: deliveryMetadata });
      }
    }
  };
  return {
    ...(ingressState ? { state: ingressState } : {}),
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
    resolveResourceId: ({ thread, message }) => scopeFor(
      thread,
      message,
      options.tenantId ?? slackTenantId(message),
      options.installationId,
    ).resourceId,
    resolveThreadId: ({ thread, message }) => scopeFor(
      thread,
      message,
      options.tenantId ?? slackTenantId(message),
      options.installationId,
    ).threadId,
    chatOptions: {
      concurrency: {
        strategy: "queue",
        maxQueueSize: 10,
        // The shared adapter rejects the new delivery atomically and exposes a
        // retryable outcome. Standalone keeps Mastra's process-memory adapter
        // but never evicts an older accepted message.
        onQueueFull: "drop-newest",
        queueEntryTtlMs: 90_000,
      },
      dedupeTtlMs: 10 * 60_000,
    },
    inlineMedia: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
  };
}

function createDistributedSlackIngressState(installationId?: string, tenantId?: string): SlackIngressStateAdapter | undefined {
  if (config.QASEY_DEPLOYMENT_MODE !== "distributed") return undefined;
  if (!config.REDIS_HOST) {
    throw new Error("Distributed Slack ingress requires REDIS_HOST");
  }
  return createRedisSlackIngressState({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT ?? 6379,
    ...(config.REDIS_USERNAME ? { username: config.REDIS_USERNAME } : {}),
    ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
    ...(config.REDIS_TLS !== undefined ? { tls: config.REDIS_TLS } : {}),
    ...(config.REDIS_TLS_SERVERNAME ? { tlsServername: config.REDIS_TLS_SERVERNAME } : {}),
    keyPrefix: `qasey:${config.QASEY_DEPLOYMENT_ID ?? config.NODE_ENV}:${installationId ?? "default"}`,
    onQueueDepth: (threadId, depth) => productionSignals.setQueueDepth({
      tenantId: tenantId ?? config.QASEY_SINGLE_TENANT_ID ?? "trusted-ingress",
      channel: "slack",
      partition: threadId,
      depth,
    }),
    onQueueOverload: () => productionSignals.incrementQueueOverload(
      tenantId ?? config.QASEY_SINGLE_TENANT_ID ?? "trusted-ingress",
      "slack",
    ),
  });
}

function scopeFor(thread: NativeThread, message: NativeMessage, tenantId: string, installationId?: string) {
  const prefix = installationId ? `${installationId}:` : "";
  return conversationScope({
    applicationId: "qasey",
    tenantId,
    userId: message.author.userId,
    conversationId: `${prefix}${thread.channelId}`,
    externalThreadId: `${prefix}${message.threadId || thread.channelId}`,
    kind: thread.isDM ? "private" : "shared",
  });
}

/** Preserve Slack's canonical link targets when converting a rich message to Agent input. */
export function buildSlackChatInput(
  text: string,
  links: readonly { url: string }[] | undefined,
): string {
  const urls = [...new Set((links ?? []).map(link => link.url.trim()).filter(Boolean))];
  if (urls.length === 0) return text;
  return `${text}\n\nLinks:\n${urls.join("\n")}`;
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
