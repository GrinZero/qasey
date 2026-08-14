import { describe, expect, it } from "vitest";
import { createTriggerEnvelope, normalizeJiraWebhook, normalizeSlackEvent } from "../../packages/domain/src/index.ts";

describe("trigger normalization", () => {
  it("preserves Slack thread identity and strips the bot mention", () => {
    const request = normalizeSlackEvent({
      event_id: "Ev01", type: "app_mention", team: "T01", channel: "C01", user: "U01",
      ts: "100.2", thread_ts: "99.1", text: "<@UBOT> 生成登录用例",
    }, "UBOT");
    expect(request).toMatchObject({ requestId: "Ev01", sessionId: "slack-thread-C01-99.1", chatInput: expect.stringContaining("生成登录用例") });
    const envelope = createTriggerEnvelope({ request: request!, source: "slack", eventType: "app_mention", tenantId: "T01" });
    expect(envelope).toMatchObject({ idempotencyKey: "slack:Ev01", conversation: { key: "slack-thread-C01-99.1" }, replyTo: { target: { channelId: "C01", threadTs: "99.1" } } });
  });

  it("ignores bot messages and Qasey's own Jira reply", () => {
    expect(normalizeSlackEvent({ type: "message", channel: "D01", user: "UBOT", ts: "1", text: "self" }, "UBOT")).toBeNull();
    expect(normalizeJiraWebhook({ issue: { key: "QA-1" }, comment: { id: "1", body: "🤖 Qasey @Qasey done" } }, "qasey-id")).toBeNull();
  });

  it("creates an issue-scoped Jira conversation", () => {
    const request = normalizeJiraWebhook({
      issue: { key: "QA-42", fields: { summary: "Checkout" } },
      comment: { id: "7", body: { content: [{ content: [{ text: "@Qasey 分析风险" }] }] }, author: { accountId: "u1", displayName: "QA" } },
    }, "qasey-id");
    expect(request).toMatchObject({ requestId: "jira:QA-42:7", sessionId: "jira-issue-QA-42", source: { issueKey: "QA-42" } });
  });
});
