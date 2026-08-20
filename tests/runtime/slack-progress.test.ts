import { describe, expect, it } from "vitest";
import {
  markSlackRequestFinished,
  markSlackRequestStarted,
  showSlackStatus,
  slackPhaseStatus,
  slackToolStatus,
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

  it("uses transient Slack status for internal phases and actual tool work", async () => {
    const statuses: string[] = [];
    const target = { startTyping: async (status?: string) => { if (status) statuses.push(status); } };

    await showSlackStatus(target, slackPhaseStatus("routing"));
    await showSlackStatus(target, slackToolStatus("github_get_pull_request_diff"));
    await showSlackStatus(target, slackToolStatus("metersphere_ms_bulk_upsert_test_cases"));
    await showSlackStatus(target, slackToolStatus("qasey_report_progress"));

    expect(statuses).toEqual([
      "正在理解需求…",
      "正在核对 PR 和代码变更…",
      "正在准备 MeterSphere 用例变更…",
    ]);
  });
});
