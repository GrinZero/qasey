import { describe, expect, it } from "vitest";
import type { QaseyRequestContext } from "../../packages/contracts/src/index.ts";
import { buildSystemPrompt } from "../../packages/domain/src/index.ts";

const context = (channel: QaseyRequestContext["channel"] = "api"): QaseyRequestContext => ({
  requestId: "request-1",
  channel,
  sessionId: "session-1",
  chatInput: "test request",
  actor: { id: "user-1" },
  source: channel === "slack" ? { channelId: "C1", threadTs: "1.0" } : {},
  attachments: [],
});

describe("Skill-driven system prompt", () => {
  it("routes every intent explicitly before Tool Discovery", () => {
    const result = buildSystemPrompt(context("slack"));

    expect(result.version).toBe(15);
    expect(result.modules).toEqual(["base", "runtime", "channel:slack"]);
    expect(result.text).toContain("意图识别与 Skill 路由（必须先执行）");
    expect(result.text).toContain("intent=qa_quick_query：加载 `qa-quick-query` Skill");
    expect(result.text).toContain("intent=qa_review：加载 `qa-review` Skill");
    expect(result.text).toContain("case_create_full 或 case_maintain_fast：加载 `metersphere-case-management` Skill");
    expect(result.text).toContain("experience_read 或 experience_write：加载 `qa-experience` Skill");
    expect(result.text).toContain("e2e_generate、e2e_rerun、e2e_repair 或 e2e_status：加载 `e2e-lifecycle` Skill");
    expect(result.text).toContain("intent=meta_or_out_of_scope：不加载专门 Skill");
    expect(result.text).toContain("intent=unknown：不加载专门 Skill");
    expect(result.text).toContain("一个请求确有多个独立目标时可以组合 intent");
    expect(result.text).toContain("完成这一步前不得搜索或调用外部工具");
    expect(result.text).toContain("search_tools");
    expect(result.text).toContain("Tool Discovery 只降低上下文成本，不代表授权");
    expect(result.text).toContain("不需要向 Runtime 登记");
    expect(result.text).not.toContain("qasey_select_task_mode");
    expect(result.text).toContain("最终答复恰好发送一次");
    expect(result.text).not.toContain("## 当前意图：");
    expect(result.text).not.toContain("写入前核对目标项目");
  });

  it("does not inject or request runtime intent registration", () => {
    const result = buildSystemPrompt(context());

    expect(result.modules).not.toContain("runtime:preselected-task-mode");
    expect(result.text).not.toContain("routerStatus");
    expect(result.text).not.toContain("relation=new");
    expect(result.text).not.toContain("qasey_select_task_mode");
  });

  it("stays cache-stable for repeated context", () => {
    expect(buildSystemPrompt(context("jira")).text).toBe(buildSystemPrompt(context("jira")).text);
    expect(buildSystemPrompt(context("jira")).modules).toContain("channel:jira");
  });
});
