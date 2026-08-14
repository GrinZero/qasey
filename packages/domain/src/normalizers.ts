import { randomUUID } from "node:crypto";
import type { AttachmentRef, QaseyRequestContext, TriggerEnvelope } from "../../contracts/src/index.ts";

export interface SlackEvent {
  event_id?: string;
  type?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
  bot_id?: string;
  subtype?: string;
  files?: Array<{ id?: string; name?: string; mimetype?: string; url_private_download?: string }>;
}

export function normalizeSlackEvent(event: SlackEvent, botUserId: string): QaseyRequestContext | null {
  const isMention = event.type === "app_mention";
  const isDm = event.channel_type === "im" || String(event.channel ?? "").startsWith("D");
  const isHumanDm = event.type === "message" && isDm && !event.bot_id && !event.subtype && event.user !== botUserId;
  if (!isMention && !isHumanDm) return null;

  const channel = String(event.channel ?? "").trim();
  const user = String(event.user ?? "").trim();
  const eventTs = String(event.ts ?? "").trim();
  if (!channel || !user || !eventTs) throw new Error("Slack event is missing channel, user, or ts");
  const threadTs = String(event.thread_ts ?? eventTs);
  const text = isMention
    ? String(event.text ?? "").replace(/^<@[A-Z0-9]+>\s*/i, "").trim()
    : String(event.text ?? "").trim();
  if (!text) throw new Error("Slack message text is empty");

  const team = String(event.team ?? "");
  const threadLink = !isDm && team
    ? `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${threadTs.replace(".", "")}`
    : undefined;
  const attachments: AttachmentRef[] = (event.files ?? []).flatMap(file => {
    if (!file.id || !file.name || !file.mimetype) return [];
    return [{
      id: file.id,
      name: file.name,
      mimeType: file.mimetype,
      source: "slack" as const,
      ...(file.url_private_download ? { url: file.url_private_download } : {}),
    }];
  });

  return {
    requestId: event.event_id || `slack:${channel}:${eventTs}`,
    channel: "slack",
    sessionId: isDm ? `slack-dm-${channel || user}` : `slack-thread-${channel}-${threadTs}`,
    chatInput: threadLink ? `${text}\n\n来源 Slack thread: ${threadLink}` : text,
    actor: { id: user },
    source: { channelId: channel, threadTs, ...(threadLink ? { sourceUrl: threadLink } : {}) },
    attachments,
  };
}

function adfToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfToText).filter(Boolean).join("\n");
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  return adfToText(record.content ?? record.body ?? "");
}

export interface JiraWebhookBody {
  webhookEvent?: string;
  issue?: {
    id?: string;
    key?: string;
    self?: string;
    fields?: { summary?: string };
  };
  comment?: {
    id?: string;
    body?: unknown;
    author?: { accountId?: string; displayName?: string; emailAddress?: string };
  };
  user?: { accountId?: string; displayName?: string };
}

export function normalizeJiraWebhook(
  input: JiraWebhookBody,
  qaseyAccountId: string,
): QaseyRequestContext | null {
  const rawComment = adfToText(input.comment?.body).trim();
  const invoked = rawComment.includes(`[~accountid:${qaseyAccountId}]`) || /@Qasey(?: \(QA Agent\))?/i.test(rawComment);
  if (!invoked || rawComment.toLowerCase().includes("🤖 qasey")) return null;
  const issueKey = String(input.issue?.key ?? input.issue?.id ?? "").trim();
  if (!issueKey) throw new Error("Jira webhook is missing issue key");
  const authorId = String(input.comment?.author?.accountId ?? input.user?.accountId ?? "unknown");
  const displayName = input.comment?.author?.displayName ?? input.user?.displayName;
  const userText = rawComment
    .replace(new RegExp(`\\[~accountid:${escapeRegExp(qaseyAccountId)}\\]`, "g"), "")
    .replace(/@Qasey(?: \(QA Agent\))?/gi, "")
    .trim();
  const origin = input.issue?.self ? new URL(input.issue.self).origin : undefined;
  const issueUrl = origin ? `${origin}/browse/${issueKey}` : undefined;
  const summary = String(input.issue?.fields?.summary ?? "").trim();
  const context = [
    `Jira issue: ${issueKey}${summary ? ` — ${summary}` : ""}`,
    displayName ? `Comment author: ${displayName}` : "",
    issueUrl ? `Source: ${issueUrl}` : "",
  ].filter(Boolean).join("\n");

  return {
    requestId: `jira:${issueKey}:${input.comment?.id ?? randomUUID()}`,
    channel: "jira",
    sessionId: `jira-issue-${issueKey}`,
    chatInput: `${userText || rawComment}\n\n${context}`.trim(),
    actor: { id: authorId, ...(displayName ? { displayName } : {}) },
    source: {
      issueKey,
      ...(input.comment?.id ? { commentId: String(input.comment.id) } : {}),
      ...(issueUrl ? { sourceUrl: issueUrl } : {}),
    },
    attachments: [],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeApiRequest(input: {
  requestId?: string;
  sessionId: string;
  chatInput: string;
  actorId: string;
}): QaseyRequestContext {
  return {
    requestId: input.requestId ?? randomUUID(),
    channel: "api",
    sessionId: input.sessionId,
    chatInput: input.chatInput.trim(),
    actor: { id: input.actorId },
    source: {},
    attachments: [],
  };
}

export function createTriggerEnvelope(input: {
  request: QaseyRequestContext;
  source: TriggerEnvelope["source"];
  eventType: string;
  intent?: TriggerEnvelope["intent"];
  tenantId?: string;
  rawPayloadRef?: string;
}): TriggerEnvelope {
  const { request } = input;
  const sourceId = request.source.issueKey ?? request.source.channelId ?? request.requestId;
  const replyTo = request.channel === "slack" && request.source.channelId && request.source.threadTs
    ? { channel: "slack" as const, target: { channelId: request.source.channelId, threadTs: request.source.threadTs } }
    : request.channel === "jira" && request.source.issueKey
      ? { channel: "jira" as const, target: { issueKey: request.source.issueKey } }
      : undefined;
  return {
    schemaVersion: "1",
    eventId: request.requestId,
    idempotencyKey: `${input.source}:${request.requestId}`,
    source: input.source,
    eventType: input.eventType,
    intent: input.intent ?? "analyze_requirement",
    occurredAt: new Date().toISOString(),
    actor: { externalId: request.actor.id, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
    subject: {
      type: "requirement",
      externalId: sourceId,
      ...(request.source.sourceUrl ? { url: request.source.sourceUrl } : {}),
    },
    conversation: { key: request.sessionId },
    ...(replyTo ? { replyTo } : {}),
    rawPayloadRef: input.rawPayloadRef ?? `event://${input.source}/${encodeURIComponent(request.requestId)}`,
    traceId: randomUUID(),
  };
}
