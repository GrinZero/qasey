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

  it("starts from the user request and ignores injected System/Skill prompts", () => {
    const projector = new SlackAgentStatusProjector();

    expect(projector.project({
      type: "step-start",
      runId: "run-1",
      step: 1,
      inputMessages: [
        { role: "user", content: [{ type: "text", text: "帮我写 Sell Product / Package 支持 Split Payment 的 case" }] },
        { role: "system", content: [{ type: "text", text: "# Case Hub 测试用例管理 System prompt" }] },
      ],
    })).toBe("正在理解 Split Payment 的测试需求…");

    expect(projector.project({
      type: "step-start",
      runId: "run-1",
      step: 2,
      inputMessages: [],
    })).toBeUndefined();
  });

  it("turns Skill and tool discovery events into user-facing preparation statuses", () => {
    const projector = new SlackAgentStatusProjector();

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "skill-1",
      toolName: "skill",
      args: { name: "e2e-lifecycle" },
    })).toBe("正在加载E2E 执行规范…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "skill-1",
      toolName: "skill",
      result: "# Case Hub 测试用例管理 System prompt",
      isError: false,
    })).toBeUndefined();

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "search-1",
      toolName: "search_tools",
      args: { query: "Case Hub 测试用例管理" },
    })).toBe("正在查找Case Hub相关能力…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "search-1",
      toolName: "search_tools",
      result: { list_items: [{}, {}, {}, {}], has_more: false },
      isError: false,
    })).toBe("已准备好 4 个Case Hub相关工具…");
  });

  it("describes local GitHub workspace, Jira, Slack, Figma, and Lark events semantically", () => {
    const projector = new SlackAgentStatusProjector();

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "github-1",
      toolName: "mastra_workspace_execute_command",
      args: { command: "gh pr diff 42 --repo example-org/web-app" },
    })).toBe("正在核对 GitHub PR #42 与相关代码…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "github-1",
      toolName: "mastra_workspace_execute_command",
      result: { exitCode: 0, stdout: "18 files changed" },
      isError: false,
    })).toBe("已完成本地 Git/GitHub 查询，正在分析代码与改动…");

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "jira-1",
      toolName: "jira_get_issue",
      args: { issueKey: "FIN-123" },
    })).toBe("正在查看 FIN-123 的需求与验收范围…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "jira-1",
      toolName: "jira_get_issue",
      result: { key: "FIN-123", summary: "Support Split Payment" },
      isError: false,
    })).toBe("已读取 FIN-123，正在核对验收范围…");

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "slack-1",
      toolName: "slack_search_messages",
      args: { query: "Split Payment" },
    })).toBe("正在搜索与Split Payment相关的讨论…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "slack-1",
      toolName: "slack_search_messages",
      result: { messages: [{}, {}, {}] },
      isError: false,
    })).toBe("已找到 3 条相关讨论，正在提取结论…");

    const figmaStatus = projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "figma-1",
      toolName: "figma_get_node_detail",
      args: { file_key: "secret-file-key", node_id: "101:202", title: "Checkout" },
    });
    expect(figmaStatus).toBe("正在查看Checkout的设计稿…");
    expect(figmaStatus).not.toContain("secret-file-key");

    const larkStatus = projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "lark-1",
      toolName: "lark_doc_read",
      args: { token: "secret-document-token", title: "Split Payment" },
    });
    expect(larkStatus).toBe("正在阅读Split Payment技术方案…");
    expect(larkStatus).not.toContain("secret-document-token");
  });

  it("explains Case Hub reads and writes by user-visible intent", () => {
    const projector = new SlackAgentStatusProjector();

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "case-list-1",
      toolName: "case_hub_search_cases",
      args: { query: "Split Payment" },
    })).toBe("正在读取 Case Hub 用例与审核状态…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "case-list-1",
      toolName: "case_hub_search_cases",
      result: { total: 2, items: [{}, {}], has_more: false },
      isError: false,
    })).toBe("已读取 Case Hub 用例与审核状态…");

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "case-write-1",
      toolName: "case_hub_create_change_set",
      args: { items: [{ name: "case 1" }, { name: "case 2" }] },
    })).toBe("正在冻结候选用例并启动 E2E 验证…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "case-write-1",
      toolName: "case_hub_create_change_set",
      result: { status: "committed_and_verified", itemCount: 2, createdCount: 2, updatedCount: 0, verifiedCount: 2 },
      isError: false,
    })).toBe("Change Set 已创建，正在隔离环境中生成和验证 Playwright…");
  });

  it("uses progress and step conclusions directly while hiding internal acknowledgements", () => {
    const projector = new SlackAgentStatusProjector();

    expect(projector.project({
      type: "tool-call",
      runId: "run-1",
      step: 1,
      toolCallId: "progress-1",
      toolName: "qasey_report_progress",
      args: { title: "已确认改动范围", detail: "18 files", next: "核对历史测试用例" },
    })).toBe("已确认改动范围，正在核对历史测试用例…");

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "progress-1",
      toolName: "qasey_report_progress",
      result: { accepted: true, milestone: "scope-confirmed" },
      isError: false,
    })).toBeUndefined();

    expect(projector.project({
      type: "step-finish",
      runId: "run-1",
      step: 1,
      finishReason: "tool-calls",
      text: "已确认影响 Pre-auth migration 和 Payment，继续核对现有用例。",
      toolCalls: [],
    })).toBe("已确认影响 Pre-auth migration 和 Payment，继续核对现有用例。");

    expect(projector.project({
      type: "step-finish",
      runId: "run-1",
      step: 2,
      finishReason: "tool-calls",
      toolCalls: [],
    })).toBeUndefined();

    expect(projector.project({
      type: "step-finish",
      runId: "run-1",
      step: 3,
      finishReason: "tool-calls",
      text: "# Case Hub System prompt 已识别的 intent 决定",
      toolCalls: [],
    })).toBeUndefined();
  });

  it("turns failures into a next-action status without repeating raw errors", () => {
    const projector = new SlackAgentStatusProjector();

    expect(projector.project({
      type: "tool-result",
      runId: "run-1",
      step: 1,
      toolCallId: "jira-1",
      toolName: "jira_get_issue",
      args: { issueKey: "FIN-123" },
      result: { message: "Jira read failed with 403" },
      isError: true,
    })).toBe("暂时无法读取 FIN-123，正在重新判断下一步…");

    expect(projector.project({
      type: "step-finish",
      runId: "run-1",
      step: 1,
      finishReason: "tool-calls",
      toolCalls: [],
    })).toBeUndefined();
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

    expect(status).not.toContain("top-secret");
    expect(status).not.toContain("token=secret");
    expect(status).not.toContain("abc.def.ghi");

    const conclusion = projector.project({
      type: "step-finish",
      runId: "run-1",
      step: 1,
      finishReason: "stop",
      text: "读取完成，token=document-token，api_key=should-not-leak",
      toolCalls: [],
    });
    expect(conclusion).not.toContain("document-token");
    expect(conclusion).not.toContain("should-not-leak");
  });

  it("keeps every Slack loading message within the 50-character API limit", () => {
    const projector = new SlackAgentStatusProjector();
    const statuses = [
      projector.project({
        type: "step-start",
        runId: "run-1",
        step: 12,
        inputMessages: [{ role: "user", content: "这是一个非常长的任务描述，用来验证 Slack loading message 不会超过接口允许的长度，同时仍然保留动态内容" }],
      }),
      projector.project({
        type: "tool-call",
        runId: "run-1",
        step: 12,
        toolCallId: "call-1",
        toolName: "case_hub_create_change_set_with_a_very_long_runtime_name",
        args: { repository: "payment-service", pullNumber: 1823, operation: "upsert-many-cases" },
      }),
      projector.project({
        type: "step-finish",
        runId: "run-1",
        step: 12,
        finishReason: "stop",
        text: "已确认这个非常长的阶段结论需要被安全地压缩为 Slack 能接受的 loading message，而不能导致 invalid_arguments",
        toolCalls: [],
      }),
    ].filter((status): status is string => Boolean(status));

    expect(statuses).toHaveLength(3);
    for (const status of statuses) expect([...status].length).toBeLessThanOrEqual(50);
    expect([...(statuses.at(-1) ?? "")]).toHaveLength(50);
  });
});
