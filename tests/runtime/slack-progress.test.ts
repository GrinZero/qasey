import { describe, expect, it } from "vitest";
import { slackPhaseMessage } from "../../src/agent-apps/qasey/slack-progress.ts";

describe("Qasey Slack progress", () => {
  it("moves the visible status from routing into agent execution", () => {
    expect(slackPhaseMessage("routing")).toBe("正在识别任务类型…");
    expect(slackPhaseMessage("agent")).toBe("任务类型已识别，正在分析请求并准备所需能力…");
  });

  it("reports deterministic writes without delaying the final answer", () => {
    expect(slackPhaseMessage("workflow")).toBe("分析计划已冻结，正在执行并回查外部变更…");
    expect(slackPhaseMessage("finalizing")).toBeUndefined();
  });
});
