import { describe, expect, it } from "vitest";
import { normalizeJiraWebhook } from "../../packages/domain/src/index.ts";

describe("trigger normalization", () => {
  it("ignores bot messages and Qasey's own Jira reply", () => {
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
