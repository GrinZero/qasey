import { describe, expect, it } from "vitest";
import { QaseyUIMessageSchema } from "../../packages/contracts/src/index.ts";
import { InMemoryQaseyConversationRepository } from "../../packages/domain/src/conversation-repository.ts";
import { conversationEventStreamResponse, conversationTurnsToUIMessages } from "../../src/mastra/applications/qasey/ui-message.ts";

const owner = { applicationId: "qasey", tenantId: "tenant-ui-message" };

describe("Qasey AI SDK UI message projection", () => {
  it("projects persisted turns with stable message and data-part ids", async () => {
    const repository = new InMemoryQaseyConversationRepository(() => new Date("2026-09-04T04:00:00.000Z"));
    const conversation = await repository.createConversation(owner, "qa-user");
    const started = await repository.startTurn(
      owner,
      "qa-user",
      conversation.id,
      "11111111-1111-4111-8111-111111111111",
      "检查预约改期",
    );
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "progress", {
      title: "正在分析需求",
      detail: "仅公开整理后的进度。",
      status: "working",
      rawToolName: "private_tool",
    });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "tool.started", {
      toolCallId: "github-call-1",
      toolName: "github_get_pull_request_diff",
      title: "读取 GitHub",
      inputSummary: "正在查看 example/sample-app #42 的代码改动…",
      rawAuthorization: "Bearer must-not-escape",
    });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "tool.finished", {
      toolCallId: "github-call-1",
      toolName: "github_get_pull_request_diff",
      title: "读取 GitHub",
      inputSummary: "正在查看 example/sample-app #42 的代码改动…",
      outputSummary: "已读取 PR #42，发现 3 个文件变更…",
      isError: false,
      rawResult: { source: "private source" },
    });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "assistant.delta", { text: "已完成分析。" });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "completed", { text: "已完成分析。" });
    const [turn] = await repository.listTurns(owner, "qa-user", conversation.id);
    if (!turn) throw new Error("turn missing");
    const events = await repository.events(owner, "qa-user", conversation.id, turn.id);

    const messages = conversationTurnsToUIMessages([turn], new Map([[turn.id, events]]));
    messages.forEach(message => QaseyUIMessageSchema.parse(message));

    expect(messages.map(message => [message.id, message.role])).toEqual([
      [started.turn.clientMessageId, "user"],
      [started.turn.id, "assistant"],
    ]);
    expect(messages[1]?.metadata?.latestSequence).toBe(6);
    expect(messages[1]?.parts).toContainEqual({
      type: "data-progress",
      id: `${turn.id}:progress:2`,
      data: { sequence: 2, title: "正在分析需求", detail: "仅公开整理后的进度。", status: "working" },
    });
    expect(messages[1]?.parts).toContainEqual({
      type: "dynamic-tool",
      toolCallId: "github-call-1",
      toolName: "github_get_pull_request_diff",
      title: "读取 GitHub",
      state: "output-available",
      input: { summary: "正在查看 example/sample-app #42 的代码改动…" },
      output: { summary: "已读取 PR #42，发现 3 个文件变更…" },
    });
    expect(JSON.stringify(messages)).not.toContain("private_tool");
    expect(JSON.stringify(messages)).not.toContain("must-not-escape");
    expect(JSON.stringify(messages)).not.toContain("private source");
  });

  it("streams only events after the cursor as AI SDK v6 UI chunks", async () => {
    const repository = new InMemoryQaseyConversationRepository(() => new Date("2026-09-04T04:00:00.000Z"));
    const conversation = await repository.createConversation(owner, "qa-user");
    const started = await repository.startTurn(
      owner,
      "qa-user",
      conversation.id,
      "22222222-2222-4222-8222-222222222222",
      "继续执行",
    );
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "progress", {
      title: "已接收",
      detail: "不会在 after=2 时重放。",
    });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "tool.started", {
      toolCallId: "case-search-1",
      toolName: "case_hub_search_cases",
      title: "查询已有用例",
      inputSummary: "正在读取 Case Hub 用例与审核状态…",
    });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "tool.finished", {
      toolCallId: "case-search-1",
      toolName: "case_hub_search_cases",
      title: "查询已有用例",
      inputSummary: "正在读取 Case Hub 用例与审核状态…",
      outputSummary: "已读取 Case Hub 用例与审核状态…",
      isError: false,
    });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "assistant.delta", { text: "增量答案" });
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "completed", { text: "增量答案" });

    const response = conversationEventStreamResponse({
      repository,
      owner,
      subjectId: "qa-user",
      conversationId: conversation.id,
      turn: started.turn,
      after: 2,
      signal: new AbortController().signal,
    });
    const chunks = (await response.text())
      .split("\n\n")
      .map(frame => frame.startsWith("data: ") ? frame.slice(6) : "")
      .filter(data => data && data !== "[DONE]")
      .map(data => JSON.parse(data) as { type: string; delta?: string; data?: { sequence?: number } });

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.delta)).toEqual(["增量答案"]);
    expect(chunks.some(chunk => chunk.type === "data-progress")).toBe(false);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "tool-input-available",
      toolCallId: "case-search-1",
      toolName: "case_hub_search_cases",
      dynamic: true,
    }));
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "tool-output-available",
      toolCallId: "case-search-1",
      output: { summary: "已读取 Case Hub 用例与审核状态…" },
      dynamic: true,
    }));
    expect(chunks.filter(chunk => chunk.type === "data-cursor").at(-1)?.data?.sequence).toBe(6);
    expect(chunks.at(-1)?.type).toBe("finish");
  });

  it("maps persisted failures to a public progress part and a terminal error", async () => {
    const repository = new InMemoryQaseyConversationRepository(() => new Date("2026-09-04T06:00:00.000Z"));
    const conversation = await repository.createConversation(owner, "qa-user");
    const started = await repository.startTurn(
      owner,
      "qa-user",
      conversation.id,
      "44444444-4444-4444-8444-444444444444",
      "触发失败",
    );
    await repository.appendEvent(owner, "qa-user", conversation.id, started.turn.id, "failed", {
      message: "公开且经过整理的失败信息",
      internalTool: "must_not_escape",
    });

    const response = conversationEventStreamResponse({
      repository,
      owner,
      subjectId: "qa-user",
      conversationId: conversation.id,
      turn: started.turn,
      signal: new AbortController().signal,
    });
    const body = await response.text();

    expect(body).toContain('"type":"data-progress"');
    expect(body).toContain('"status":"failed"');
    expect(body).toContain('"type":"finish","finishReason":"error"');
    expect(body).toContain('"type":"error","errorText":"公开且经过整理的失败信息"');
    expect(body).not.toContain("must_not_escape");
  });
});
