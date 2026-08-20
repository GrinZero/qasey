import { describe, expect, it } from "vitest";
import type { EvidenceCompletionReceipt } from "../../packages/domain/src/index.ts";
import { slackCaseCompletionCards } from "../../src/mastra/applications/qasey/slack-case-delivery.ts";

describe("Slack MeterSphere case delivery", () => {
  it("renders trusted read-back cases as a native table card", () => {
    const receipt: EvidenceCompletionReceipt = {
      casePlanHash: "plan",
      write: { sourceKey: "write", toolName: "write", status: "acquired", attempts: 1 },
      verification: { sourceKey: "verify", toolName: "verify", status: "acquired", attempts: 1 },
      verificationMode: "separate_read_back",
      caseOperation: {
        moduleId: "module-1",
        modulePath: "/AI Draft/Split Payment",
        featureName: "Split Payment",
        cases: [
          { id: "case-1", num: 101, name: "分拆支付成功", priority: "P0", verified: true },
          { id: "case-2", num: 102, name: "第二次支付失败", priority: "P1", verified: true },
        ],
        itemCount: 2,
        createdCount: 2,
        updatedCount: 0,
        verifiedCount: 2,
        verificationMode: "separate_read_back",
      },
    };

    const cards = slackCaseCompletionCards(receipt, {
      baseUrl: "https://metersphere.example.com/",
      projectId: "project-1",
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      type: "card",
      title: "Split Payment · MeterSphere 测试用例",
      subtitle: "新建 2 条 · 更新 0 条 · 独立回查 2/2",
      children: [
        { type: "text", content: expect.stringContaining("moduleId=module-1") },
        {
          type: "table",
          headers: ["ID", "用例名称", "优先级"],
          rows: [["101", "分拆支付成功", "P0"], ["102", "第二次支付失败", "P1"]],
        },
      ],
    });
  });

  it("does not invent a table without a completion receipt", () => {
    expect(slackCaseCompletionCards(undefined, { baseUrl: "https://metersphere.example.com", projectId: "project" })).toEqual([]);
  });
});
