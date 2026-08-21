import { describe, expect, it } from "vitest";
import {
  markSlackRequestFinished,
  markSlackRequestStarted,
  showSlackStatus,
  SlackAgentStatusProjector,
} from "../../src/mastra/applications/qasey/slack-progress.ts";

describe("Qasey Slack progress", () => {
  it("acknowledges work without posting internal phase messages", async () => {
    const calls: string[] = [];
    const target = {
      addReaction: async (emoji: string) => { calls.push(`add:${emoji}`); },
      removeReaction: async (emoji: string) => { calls.push(`remove:${emoji}`); },
    };

    await markSlackRequestStarted(target);
    await markSlackRequestFinished(target, "success");

    expect(calls).toEqual(["add:👀", "remove:👀", "add:✅"]);
  });

  it("marks failures and never lets reaction errors fail the task", async () => {
    const calls: string[] = [];
    const target = {
      addReaction: async (emoji: string) => {
        calls.push(`add:${emoji}`);
        if (emoji === "👀") throw new Error("missing reactions:write");
      },
      removeReaction: async (emoji: string) => {
        calls.push(`remove:${emoji}`);
        throw new Error("reaction was not present");
      },
    };

    await expect(markSlackRequestStarted(target)).resolves.toBeUndefined();
    await expect(markSlackRequestFinished(target, "failure")).resolves.toBeUndefined();
    expect(calls).toEqual(["add:👀", "remove:👀", "add:⚠️"]);
  });

  it("projects actual Agent event payloads instead of fixed phase labels", () => {
    const projector = new SlackAgentStatusProjector();

    expect(projector.project({
      type: "step-start",
      runId: "run-1",
      step: 1,
      inputMessages: [{ role: "user", content: [{ type: "text", text: "分析 payment-service #1823" }] }],
    })).toContain("payment-service #1823");

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "call-1",
      toolName: "github_get_pull_request_diff",
      args: { owner: "moego", repo: "payment-service", pullNumber: 1823 },
    })).toContain("moego");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "call-1",
      toolName: "github_get_pull_request_diff",
      result: { changedFiles: 18, additions: 421, summary: "影响 Pre-auth migration" },
      isError: false,
    })).toContain("影响 Pre-auth migration");

    expect(projector.project({
      type: "step-finish",
      runId: "run-1",
      step: 1,
      finishReason: "tool-calls",
      text: "已确认影响 Pre-auth migration 和 Payment，继续核对现有用例。",
      toolCalls: [],
    })).toBe("已确认影响 Pre-auth migration 和 Payment，继续核对现有用例。");
  });

  it("redacts credentials and URL query strings from projected statuses", () => {
    const projector = new SlackAgentStatusProjector();
    const status = projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "call-1",
      toolName: "http_request",
      args: {
        authorization: "Bearer top-secret",
        url: "https://example.test/items?token=secret",
        query: "Bearer abc.def.ghi",
      },
    });

    expect(status).toContain("https://example.test/items");
    expect(status).not.toContain("top-secret");
    expect(status).not.toContain("token=secret");
    expect(status).not.toContain("abc.def.ghi");

    const conclusion = projector.project({
      type: "step-finish",
      runId: "run-1",
      step: 1,
      finishReason: "stop",
      text: "读取完成，api_key=should-not-leak",
      toolCalls: [],
    });
    expect(conclusion).not.toContain("should-not-leak");
  });
});
