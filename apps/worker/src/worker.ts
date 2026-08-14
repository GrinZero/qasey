import "../../../src/mastra/instrumentation.ts";
import { randomUUID } from "node:crypto";
import type { OutboundMessage, TriggerEnvelope } from "../../../packages/contracts/src/index.ts";
import { logError, logInfo } from "../../../packages/adapters/src/index.ts";
import { config, jiraClient, notificationOutbox, slackLifecycle, triggerQueue } from "../../../src/mastra/runtime.ts";
import { executeQasey } from "../../../src/mastra/service.ts";
import { mastra } from "../../../src/mastra/index.ts";

const workerId = `${process.env.HOSTNAME ?? "local"}:${process.pid}`;

class TriggerLeaseLostError extends Error {
  constructor() { super("Trigger lease was lost while the job was running"); this.name = "TriggerLeaseLostError"; }
}

class SlackProgressReporter {
  private messageTs?: string;
  private lastUpdateAt = 0;
  private lastText = "";

  constructor(
    private readonly channelId?: string,
    private readonly threadTs?: string,
    private readonly minIntervalMs = 5_000,
  ) {}

  async start(): Promise<void> {
    if (!this.channelId || !this.threadTs || config.QASEY_SHADOW_MODE) return;
    try {
      this.messageTs = await slackLifecycle.postProgress(
        this.channelId,
        this.threadTs,
        ":hourglass_flowing_sand: 已接收，正在分析请求…",
      );
      this.lastUpdateAt = Date.now();
    } catch (error) {
      logError("worker.slack.progress.failed", error, { workerId, stage: "start" });
    }
  }

  async update(text: string, force = false): Promise<void> {
    if (!this.channelId || !this.messageTs || text === this.lastText) return;
    if (!force && Date.now() - this.lastUpdateAt < this.minIntervalMs) return;
    try {
      await slackLifecycle.updateProgress(this.channelId, this.messageTs, text);
      this.lastText = text;
      this.lastUpdateAt = Date.now();
    } catch (error) {
      logError("worker.slack.progress.failed", error, { workerId, stage: "update" });
    }
  }
}

function resultMessage(envelope: TriggerEnvelope, text: string, runId: string): OutboundMessage | undefined {
  if (!envelope.replyTo) return undefined;
  return {
    id: randomUUID(),
    idempotencyKey: `${envelope.idempotencyKey}:result`,
    channel: envelope.replyTo.channel,
    target: envelope.replyTo.target,
    messageType: "result",
    content: { text, runId },
  };
}

export async function processNextTrigger(): Promise<boolean> {
  const job = await triggerQueue.claim(workerId);
  if (!job) return false;
  const startedAt = Date.now();
  const executionController = new AbortController();
  const progress = new SlackProgressReporter(
    job.envelope.replyTo?.channel === "slack" ? job.envelope.replyTo.target.channelId : undefined,
    job.envelope.replyTo?.channel === "slack" ? job.envelope.replyTo.target.threadTs : undefined,
  );
  const stopHeartbeat = startTriggerHeartbeat(job.id, executionController, startedAt);
  logInfo("worker.trigger.claimed", {
    workerId,
    jobId: job.id,
    eventId: job.envelope.eventId,
    source: job.envelope.source,
    eventType: job.envelope.eventType,
    attempt: job.attempts,
    timeoutMs: config.QASEY_AGENT_TIMEOUT_MS,
    shadowMode: config.QASEY_SHADOW_MODE,
  });
  try {
    if (!config.QASEY_SHADOW_MODE && job.envelope.replyTo?.channel === "slack") {
      const { channelId, threadTs } = job.envelope.replyTo.target;
      if (channelId && threadTs) await slackLifecycle.markProcessing(channelId, threadTs).catch(() => undefined);
    }
    await progress.start();
    const response = await executeQasey(mastra, job.request, {
      abortSignal: executionController.signal,
      timeoutMs: config.QASEY_AGENT_TIMEOUT_MS,
      events: {
        onPhase: async event => {
          logInfo("worker.agent.phase", {
            workerId, jobId: job.id, eventId: job.envelope.eventId, runId: event.runId, phase: event.phase,
            durationMs: Date.now() - startedAt,
          });
          if (event.phase === "agent") await progress.update(":mag: 已理解请求，正在检索资料并规划测试用例…", true);
          if (event.phase === "finalizing") await progress.update(":memo: 工具执行完成，正在整理最终结果…", true);
        },
        onToolStart: async event => {
          logInfo("worker.agent.tool.started", {
            workerId, jobId: job.id, eventId: job.envelope.eventId, runId: event.runId,
            toolName: event.toolName, inputKeys: event.inputKeys.join(","), durationMs: Date.now() - startedAt,
          });
          await progress.update(progressForTool(event.toolName));
        },
        onToolEnd: event => {
          const fields = {
            workerId, jobId: job.id, eventId: job.envelope.eventId, runId: event.runId,
            toolName: event.toolName, toolDurationMs: event.durationMs, outputType: event.outputType,
            toolDisposition: event.disposition,
            durationMs: Date.now() - startedAt,
          };
          if (event.error) logError("worker.agent.tool.failed", event.error, fields);
          else logInfo("worker.agent.tool.completed", fields);
        },
        onIteration: async event => {
          logInfo("worker.agent.iteration.completed", {
            workerId, jobId: job.id, eventId: job.envelope.eventId, runId: event.runId,
            iteration: event.iteration, finishReason: event.finishReason, isFinal: event.isFinal,
            textChars: event.textChars, toolCount: event.toolNames.length,
            toolNames: event.toolNames.join(","), toolCallIds: event.toolCallIds.join(","),
            failedTools: event.failedTools.join(","), durationMs: Date.now() - startedAt,
          });
          if (!event.isFinal) {
            await progress.update(`:brain: 已完成第 ${event.iteration} 轮分析，正在继续处理…`);
          }
        },
      },
    });
    if (config.QASEY_SHADOW_MODE) {
      logInfo("worker.trigger.shadow_result", {
        workerId,
        jobId: job.id,
        eventId: job.envelope.eventId,
        runId: response.runId,
        intent: response.route.intent,
        response: agentResponsePreview(response.text),
      });
    }
    const message = resultMessage(job.envelope, response.text, response.runId);
    if (!await triggerQueue.heartbeat(job.id, workerId)) throw new TriggerLeaseLostError();
    const notificationQueued = Boolean(message && !config.QASEY_SHADOW_MODE && await notificationOutbox.publish(message));
    stopHeartbeat();
    if (!await triggerQueue.complete(job.id, workerId)) throw new TriggerLeaseLostError();
    await progress.update(":white_check_mark: 已完成，正在发送结果…", true);
    logInfo("worker.trigger.completed", {
      workerId,
      jobId: job.id,
      eventId: job.envelope.eventId,
      runId: response.runId,
      intent: response.route.intent,
      outcome: response.outcome,
      writeTool: response.completionReceipt?.write.toolName,
      verificationTool: response.completionReceipt?.verification.toolName,
      actualToolExecutions: response.evidenceStats.actualExecutions,
      deduplicatedToolCalls: response.evidenceStats.deduplicatedCalls,
      cachedToolFailures: response.evidenceStats.cachedFailures,
      artifactReads: response.evidenceStats.artifactReads,
      artifactizedResults: response.evidenceStats.artifactizedResults,
      duplicateResultCharsAvoided: response.evidenceStats.duplicateResultCharsAvoided,
      notificationQueued,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const upstream = upstreamErrorFields(error);
    stopHeartbeat();
    const leaseOwned = await triggerQueue.fail(job.id, workerId, message);
    const timedOut = isTimeoutError(error);
    if (timedOut) {
      logError("worker.trigger.timed_out", error, {
        workerId, jobId: job.id, eventId: job.envelope.eventId,
        timeoutMs: config.QASEY_AGENT_TIMEOUT_MS, durationMs: Date.now() - startedAt,
      });
    }
    if (!leaseOwned) {
      logError("worker.trigger.lease_lost", error, {
        workerId, jobId: job.id, eventId: job.envelope.eventId, durationMs: Date.now() - startedAt,
      });
    }
    if (leaseOwned && job.attempts >= 3 && job.envelope.replyTo && !config.QASEY_SHADOW_MODE) {
      await notificationOutbox.publish({
        id: randomUUID(),
        idempotencyKey: `${job.envelope.idempotencyKey}:error`,
        channel: job.envelope.replyTo.channel,
        target: job.envelope.replyTo.target,
        messageType: "error",
        content: { text: `抱歉，这次操作没有成功。\nRequest ID: \`${job.envelope.traceId}\`` },
      });
    }
    await progress.update(
      leaseOwned && job.attempts < 3
        ? ":warning: 本次执行中断，系统将自动重试…"
        : ":x: 本次执行未完成，请查看错误信息或联系维护者。",
      true,
    );
    logError("worker.trigger.failed", error, {
      workerId,
      jobId: job.id,
      eventId: job.envelope.eventId,
      attempt: job.attempts,
      retrying: job.attempts < 3,
      durationMs: Date.now() - startedAt,
      ...upstream,
    });
  } finally {
    stopHeartbeat();
  }
  return true;
}

function startTriggerHeartbeat(jobId: string, controller: AbortController, startedAt: number): () => void {
  let stopped = false;
  let pending = false;
  let consecutiveErrors = 0;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = true;
    void triggerQueue.heartbeat(jobId, workerId).then(owned => {
      consecutiveErrors = 0;
      if (!owned) {
        logInfo("worker.trigger.lease_lost", { workerId, jobId, durationMs: Date.now() - startedAt });
        controller.abort(new TriggerLeaseLostError());
        return;
      }
      logInfo("worker.trigger.heartbeat", { workerId, jobId, durationMs: Date.now() - startedAt });
    }).catch(error => {
      consecutiveErrors += 1;
      logError("worker.trigger.heartbeat_failed", error, { workerId, jobId, consecutiveErrors });
      if (consecutiveErrors >= 3) controller.abort(new Error("Trigger heartbeat failed three consecutive times"));
    }).finally(() => { pending = false; });
  }, config.QASEY_JOB_HEARTBEAT_MS);
  timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /timed?\s*out|timeout/i.test(error.message);
}

function progressForTool(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("jira")) return ":link: 正在读取 Jira 需求与上下文…";
  if (normalized.includes("metersphere") || normalized.startsWith("ms_")) {
    return /create|edit|upsert|write/.test(normalized)
      ? ":pencil2: 正在把新测试用例写入 MeterSphere AI Draft…"
      : ":card_index_dividers: 正在读取 MeterSphere 测试资料…";
  }
  if (normalized.includes("rag") || normalized.includes("answer")) return ":mag_right: 正在检索相关产品资料…";
  if (normalized.includes("figma")) return ":frame_with_picture: 正在读取 Figma 设计信息…";
  if (normalized.includes("typescript")) return ":gear: 正在批量处理资料与测试用例…";
  return `:gear: 正在调用 ${toolName}…`;
}

function upstreamErrorFields(error: unknown): Record<string, string | number | null | undefined> {
  if (!error || typeof error !== "object") return {};
  const candidate = error as {
    statusCode?: number;
    url?: string;
    responseHeaders?: Record<string, string | undefined>;
  };
  return {
    upstreamStatus: candidate.statusCode,
    upstreamUrl: candidate.url,
    upstreamRequestId: candidate.responseHeaders?.["x-request-id"],
    upstreamClientRequestId: candidate.responseHeaders?.["x-client-request-id"],
  };
}

function agentResponsePreview(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
}

export async function dispatchNextNotification(): Promise<boolean> {
  const message = await notificationOutbox.claim(workerId);
  if (!message) return false;
  try {
    if (message.channel === "slack") {
      const { channelId, threadTs } = message.target;
      if (!channelId || !threadTs) throw new Error("Slack notification target is incomplete");
      await slackLifecycle.postReply(channelId, threadTs, message.content.text, message.id);
      if (message.messageType === "result") await slackLifecycle.markSucceeded(channelId, threadTs).catch(() => undefined);
    } else if (message.channel === "jira") {
      const issueKey = message.target.issueKey;
      if (!issueKey) throw new Error("Jira notification target is incomplete");
      await jiraClient.addComment(issueKey, `${message.content.text}\n\nDelivery: ${message.id}`);
    } else throw new Error(`Notification channel is not configured: ${message.channel}`);
    await notificationOutbox.complete(message.id);
    logInfo("worker.notification.sent", {
      workerId,
      notificationId: message.id,
      channel: message.channel,
      messageType: message.messageType,
    });
  } catch (error) {
    await notificationOutbox.fail(message.id, error instanceof Error ? error.message : String(error));
    logError("worker.notification.failed", error, {
      workerId,
      notificationId: message.id,
      channel: message.channel,
      messageType: message.messageType,
    });
  }
  return true;
}

export async function workerLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const handled = await processNextTrigger();
    const dispatched = await dispatchNextNotification();
    if (!handled && !dispatched) await new Promise(resolve => setTimeout(resolve, config.QASEY_WORKER_POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required for the worker's durable queue");
  logInfo("worker.started", {
    workerId,
    pollMs: config.QASEY_WORKER_POLL_MS,
    heartbeatMs: config.QASEY_JOB_HEARTBEAT_MS,
    leaseMs: config.QASEY_JOB_LEASE_MS,
    agentTimeoutMs: config.QASEY_AGENT_TIMEOUT_MS,
    shadowMode: config.QASEY_SHADOW_MODE,
    memoryStorage: "postgres",
    memoryMode: "observational",
    memoryModel: config.QASEY_MEMORY_MODEL,
    memoryMessageTokens: config.QASEY_MEMORY_MESSAGE_TOKENS,
    memoryObservationTokens: config.QASEY_MEMORY_OBSERVATION_TOKENS,
    memoryInputTokenLimit: config.QASEY_MEMORY_INPUT_TOKEN_LIMIT,
  });
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await workerLoop(controller.signal);
}
