import { describe, expect, it } from "vitest";
import {
  AgentProgressSession,
  MAX_AGENT_PROGRESS_REPORTS,
  formatQaseyProgress,
} from "../../packages/domain/src/index.ts";

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
    const session = new AgentProgressSession(report => {
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
    const session = new AgentProgressSession(() => undefined);
    await expect(session.report({
      milestone: "write_result",
      title: "Case Hub Change Set 已提交",
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

  it("uses one intent-independent reporting budget", async () => {
    const session = new AgentProgressSession(() => undefined);
    for (let index = 0; index < MAX_AGENT_PROGRESS_REPORTS; index += 1) {
      await expect(session.report({
        milestone: `stage_${index}`,
        title: `阶段 ${index}`,
        detail: "发现了会改变当前结论的新信息。",
      })).resolves.toMatchObject({ accepted: true, sequence: index + 1 });
    }
    await expect(session.report({
      milestone: "over_limit",
      title: "额外阶段",
      detail: "这条进展超过统一预算。",
    })).resolves.toMatchObject({ accepted: false, reason: "limit_reached" });
  });
});
