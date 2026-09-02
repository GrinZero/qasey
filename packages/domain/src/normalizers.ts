import { randomUUID } from "node:crypto";
import type { QaseyRequestContext } from "../../contracts/src/index.ts";

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
    actor: { id: authorId, ...(displayName ? { displayName } : {}), ...(origin ? { tenantId: new URL(origin).hostname } : {}) },
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
