import { describe, expect, it } from "vitest";
import {
  AgentProgressSession,
  buildSystemPrompt,
  formatQaseyProgress,
} from "../../packages/domain/src/index.ts";
import type { IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";

const route = (intent: IntentRoute["intent"]): IntentRoute => ({
  version: 2,
  intent,
  relation: "new",
  writeTarget: intent.startsWith("case_") ? "metersphere" : "none",
  depth: "standard",
  confidence: 1,
  reason: "test",
  routerStatus: "ok",
});

describe("runtime-owned progress events", () => {
  it("only formats exceptional retry or failure facts", () => {
    const text = formatQaseyProgress({
      phase: "retrying", attempt: 1, error: "upstream timeout",
    });
    expect(text).toContain("准备重试");
    expect(text).toContain("upstream timeout");
    expect(text).not.toMatch(/tool|第 \d+ 轮/i);
  });
});

describe("agent-driven progress", () => {
  it("delivers task-specific progress once per stable milestone", async () => {
    const delivered: string[] = [];
    const session = new AgentProgressSession(route("case_create_full"), report => {
      delivered.push(`${report.sequence}:${report.title}`);
    }, () => new Date("2026-08-17T00:00:00.000Z"));

    const input = {
      milestone: "payment_rules",
      title: "正在核对分账与尾差规则",
      detail: "Jira 没有明确尾差归属，正在结合代码确认实际行为。",
      next: "整理风险并形成用例方案",
      status: "working" as const,
    };
    await expect(session.report(input)).resolves.toEqual({ accepted: true, milestone: "payment_rules", sequence: 1 });
    await expect(session.report(input)).resolves.toMatchObject({ accepted: false, reason: "duplicate", sequence: 1 });
    expect(delivered).toEqual(["1:正在核对分账与尾差规则"]);
    expect(session.reports()).toMatchObject([{ milestone: "payment_rules", occurredAt: "2026-08-17T00:00:00.000Z" }]);
  });

  it("keeps externally verified completion claims reserved for the runtime", async () => {
    const session = new AgentProgressSession(route("case_create_full"), () => undefined);
    await expect(session.report({
      milestone: "write_result",
      title: "MeterSphere 写入完成",
      detail: "所有用例已经成功写入。",
      status: "working",
    })).resolves.toMatchObject({ accepted: false, reason: "unverified_completion_claim" });
    await expect(session.report({
      milestone: "verified",
      title: "准备核对结果",
      detail: "即将读取正式写入的结果。",
      status: "working",
    })).resolves.toMatchObject({ accepted: false, reason: "reserved_milestone" });
  });

  it("applies different reporting budgets by intent", async () => {
    const session = new AgentProgressSession(route("qa_quick_query"), () => undefined);
    await expect(session.report({ milestone: "research", title: "正在查找配置来源", detail: "需要交叉核对两个配置文件。" }))
      .resolves.toMatchObject({ accepted: true });
    await expect(session.report({ milestone: "comparison", title: "正在比较配置", detail: "准备确认两处配置是否一致。" }))
      .resolves.toMatchObject({ accepted: false, reason: "limit_reached" });
  });

  it("injects intent-specific progress guidance and skips it for simple meta answers", () => {
    const context: QaseyRequestContext = {
      requestId: "request-1",
      channel: "api",
      sessionId: "session-1",
      chatInput: "review",
      actor: { id: "user-1" },
      source: {},
      attachments: [],
    };
    const review = buildSystemPrompt(context, route("qa_review"));
    expect(review.version).toBe(9);
    expect(review.modules).toContain("progress:agent_reporter");
    expect(review.text).toContain("最多报告 2 次");
    expect(review.text).toContain("不要按“范围确认→证据核对→风险评审”逐阶段打卡");
    expect(review.text).toContain("不要使用“开始分析”");

    const meta = buildSystemPrompt(context, route("meta_or_out_of_scope"));
    expect(meta.modules).not.toContain("progress:agent_reporter");
  });
});
