import "../../../src/mastra/instrumentation.ts";
import { App, LogLevel } from "@slack/bolt";
import { createTriggerEnvelope, normalizeSlackEvent } from "../../../packages/domain/src/index.ts";
import { logError, logInfo } from "../../../packages/adapters/src/index.ts";
import { config, triggerQueue } from "../../../src/mastra/runtime.ts";

function requireSlackConfig(): void {
  if (!config.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is required");
  if (!config.SLACK_SOCKET_MODE_APP_TOKEN && !config.SLACK_SIGNING_SECRET) {
    throw new Error("SLACK_SIGNING_SECRET is required for HTTP mode");
  }
}

requireSlackConfig();
if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required because the Slack receiver and worker use a durable cross-process queue");

const socketMode = Boolean(config.SLACK_SOCKET_MODE_APP_TOKEN);
const common = {
  token: config.SLACK_BOT_TOKEN!,
  logLevel: config.NODE_ENV === "development" ? LogLevel.INFO : LogLevel.WARN,
};
const app = config.SLACK_SOCKET_MODE_APP_TOKEN
  ? new App({ ...common, socketMode: true, appToken: config.SLACK_SOCKET_MODE_APP_TOKEN })
  : new App({ ...common, signingSecret: config.SLACK_SIGNING_SECRET! });

async function enqueueSlack(body: Record<string, unknown>, event: Record<string, unknown>): Promise<void> {
  const request = normalizeSlackEvent({
    ...event,
    event_id: String(body.event_id ?? ""),
    team: String(body.team_id ?? event.team ?? ""),
  }, config.SLACK_BOT_USER_ID);
  if (!request) return;
  const tenantId = String(body.team_id ?? "");
  const envelope = createTriggerEnvelope({
    request,
    source: "slack",
    eventType: String(event.type ?? "message"),
    ...(tenantId ? { tenantId } : {}),
    rawPayloadRef: `slack-event://${encodeURIComponent(String(body.event_id ?? request.requestId))}`,
  });
  try {
    const accepted = await triggerQueue.enqueue(envelope, request);
    logInfo("slack.event.received", {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      teamId: tenantId || null,
      channelId: request.source.channelId,
      threadTs: request.source.threadTs,
      actorId: request.actor.id,
      ...(config.NODE_ENV === "development" ? { message: slackMessagePreview(event.text) } : {}),
      accepted,
      duplicate: !accepted,
    });
  } catch (error) {
    logError("slack.event.enqueue_failed", error, {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      channelId: request.source.channelId,
    });
    throw error;
  }
}

function slackMessagePreview(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

app.event("app_mention", async ({ body, event }) => enqueueSlack(body as unknown as Record<string, unknown>, event as unknown as Record<string, unknown>));
app.event("app_home_opened", async () => undefined);
app.message(async ({ body, message }) => enqueueSlack(body as unknown as Record<string, unknown>, message as unknown as Record<string, unknown>));
app.error(async error => { logError("slack.receiver.error", error); });

if (socketMode) await app.start();
else await app.start(config.SLACK_RECEIVER_PORT);
logInfo("slack.receiver.started", {
  mode: socketMode ? "socket" : "http",
  ...(socketMode ? {} : { port: config.SLACK_RECEIVER_PORT }),
});
