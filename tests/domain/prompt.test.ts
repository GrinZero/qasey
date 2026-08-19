import { describe, expect, it } from "vitest";
import type { Intent, IntentRoute, QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { buildSystemPrompt } from "../../packages/domain/src/index.ts";

const writeTargets: Record<Intent, IntentRoute["writeTarget"]> = {
  qa_quick_query: "none",
  qa_review: "none",
  case_create_full: "metersphere",
  case_maintain_fast: "metersphere",
  experience_read: "none",
  experience_write: "qa_experience",
  meta_or_out_of_scope: "none",
  unknown: "none",
  e2e_generate: "git",
  e2e_rerun: "none",
  e2e_repair: "git",
  e2e_status: "none",
};

const context = (channel: QaseyRequestContext["channel"] = "api"): QaseyRequestContext => ({
  requestId: "request-1",
  channel,
  sessionId: "session-1",
  chatInput: "test request",
  actor: { id: "user-1" },
  source: channel === "slack" ? { channelId: "C1", threadTs: "1.0" } : channel === "jira" ? { issueKey: "QA-1" } : {},
  attachments: [],
});

const route = (
  intent: Intent,
  depth: IntentRoute["depth"] = "standard",
  relation: IntentRoute["relation"] = "new",
): IntentRoute => ({
  version: 2,
  intent,
  relation,
  writeTarget: writeTargets[intent],
  depth,
  confidence: 1,
  reason: "test",
  routerStatus: "ok",
});

const intentExpectations: Record<Intent, string[]> = {
  qa_quick_query: ["单一事实或决策", "不得执行持久化写入"],
  qa_review: ["矛盾、遗漏、歧义", "建议测试范围"],
  case_create_full: ["canonical cases", "completion receipt", "确定性 Workflow 将接管后续写入"],
  case_maintain_fast: ["新增、修改、失效和保持不变", "确定性 Workflow 负责精确写入"],
  experience_read: ["历史风险线索", "不得修改 QA Experience"],
  experience_write: ["人工审批", "回读一致"],
  meta_or_out_of_scope: ["不要启动完整取证", "一到三个短段落"],
  unknown: ["最多提出一个聚焦问题", "不得执行持久化写入"],
  e2e_generate: ["确定性 lifecycle", "创建成功只表示 run 已进入 lifecycle"],
  e2e_rerun: ["不得复用旧 run ID", "新 run"],
  e2e_repair: ["不得通过弱化断言", "fresh verifier"],
  e2e_status: ["不得触发 rerun", "下一责任方"],
};

describe("intent-aware system prompt", () => {
  it.each(Object.entries(intentExpectations) as Array<[Intent, string[]]>)(
    "builds the %s objective, protocol, completion condition, and output contract",
    (intent, expectedText) => {
      const result = buildSystemPrompt(context(), route(intent));
      expect(result.version).toBe(9);
      expect(result.modules).toContain(`intent:${intent}`);
      expect(result.text).toContain(`## 当前意图：${intent}`);
      expect(result.text).toContain("### 目标");
      expect(result.text).toContain("### 执行协议");
      expect(result.text).toContain("### 完成条件");
      expect(result.text).toContain("### 输出合同");
      for (const text of expectedText) expect(result.text).toContain(text);
    },
  );

  it("turns depth into an actual prompt module", () => {
    const quick = buildSystemPrompt(context(), route("qa_review", "quick"));
    const standard = buildSystemPrompt(context(), route("qa_review", "standard"));
    const deep = buildSystemPrompt(context(), route("qa_review", "deep"));

    expect(quick.modules).toContain("depth:quick");
    expect(quick.text).toContain("不做预防性全库搜索");
    expect(standard.modules).toContain("depth:standard");
    expect(standard.text).toContain("追加一个独立来源交叉验证");
    expect(deep.modules).toContain("depth:deep");
    expect(deep.text).toContain("多来源核对");
  });

  it("uses relation to control history inheritance without granting writes", () => {
    const followUp = buildSystemPrompt(context(), route("unknown", "quick", "follow_up"));
    expect(followUp.modules).toContain("relation:follow_up");
    expect(followUp.text).toContain("继续最近仍未解决的同一目标");
    expect(followUp.text).toContain("是否允许写入只以本轮结构化 intent/write_target 为准");

    const unknown = buildSystemPrompt(context(), route("unknown", "quick", "unknown"));
    expect(unknown.modules).toContain("relation:unknown");
    expect(unknown.text).toContain("不能单独授权写入");
  });

  it("keeps the prompt cache-stable and injects only the channel delivery contract", () => {
    const slack = buildSystemPrompt(context("slack"), route("case_create_full", "deep"));
    const repeated = buildSystemPrompt(context("slack"), route("case_create_full", "deep"));
    expect(repeated.text).toBe(slack.text);
    expect(slack.text).not.toContain("当前日期");
    expect(slack.modules).toContain("channel:slack");
    expect(slack.text).toContain("最终用例表由系统依据可信回查结果交付");
    expect(slack.text).toContain("由 Slack 临时状态承载“正在处理”");

    const jira = buildSystemPrompt(context("jira"), route("qa_review"));
    expect(jira.modules).toContain("channel:jira");
    expect(jira.text).toContain("最终答复由 Jira adapter 回写");
  });

  it("keeps the n8n evidence and progress boundaries in the case prompt", () => {
    const result = buildSystemPrompt(context("slack"), route("case_create_full", "deep"));
    expect(result.modules).toContain("qa:deep_investigation");
    expect(result.modules).toContain("qa:case_evidence");
    expect(result.text).toContain("每条用例选择 1–3 条直接支撑");
    expect(result.text).toContain("完成第一个有信息增量的阶段后至少报告一次");
  });
});
