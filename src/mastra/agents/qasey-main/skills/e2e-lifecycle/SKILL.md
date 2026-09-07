---
name: e2e-lifecycle
description: 统一处理文字 Case Review 与 E2E lifecycle：先提交可编辑文字用例，批准后再按精确版本生成 Playwright、审阅证据、重跑或查询状态。
---

# E2E Lifecycle

System prompt 已识别的 intent 决定执行 `e2e_generate`、`e2e_rerun`、`e2e_repair` 或 `e2e_status` 模式。只执行请求对应的模式；状态查询不得顺带触发状态变化。

## 共享约束

- 首期只支持 Web Chromium Playwright；所有状态、结果和 artifacts 只以真实 lifecycle 事件为准。
- 不直接修改仓库、扩大允许路径、绕过 clean verifier、自动合并 PR，或用 Author workspace 的结果替代独立验证。
- 缺少关键 run、来源用例、仓库或执行条件时不猜测。
- `case_hub_create_change_set` 是已停用的旧直启入口；它只会返回 `text_case_review_required`，不得调用或尝试绕过文字审核。

## case_create_full / case_maintain_fast：创建文字 Review Plan

- 调用创建工具前，把当前消息、thread memory、附件及前序工具证据整理成结构化 handoff：目标、需求摘要、范围、已确认决策、约束、假设、关键流、边界、负向场景、数据需求、仓库发现、阻塞问题和证据引用。
- Case Hub 是结构化用例的唯一真相源；Git 只保存 Playwright，不保存 Case YAML。
- 有未解决的阻塞问题时先向用户澄清，不得创建 Review Plan。
- 先用 `case_hub_search_cases` 查重，再把 create/update 文字 proposal 与 Requirement Snapshot 一次性交给 `case_hub_create_review_plan`。
- 每条草稿必须有完整步骤/预期、优先级、suite 和用户 tags。Case ID、版本、hash、automationPath、证据和系统标签由服务端管理，不得写入 proposal。
- 创建成功只表示文字草稿等待用户审核；不得在同一轮启动 E2E，也不得声称已生成自动化。

返回真实 Review Plan ID，并明确用户可以逐条编辑、移除、恢复和批准。

## e2e_generate：复用已批准文字版本创建 run

- 当前租户已批准文字用例是可跨会话复用的资产。用户在普通聊天明确要求生成或修改自动化时，使用 `case_hub_search_cases`、`case_hub_get_case` 定位现有 activeVersionId，直接调用 `case_hub_start_e2e`（planId 可省略）。不因来自其他会话或已有成功结果而重建文字用例、版本或 Review Plan。
- 只有新增或实际改变步骤、预期、范围才进入文字审核；测试实现的 locator、等待、结构、视频或报告优化不改变文字版本。
- 如果有可信 action，将其中的 `planId` 和有序 `caseVersionIds` 原样传给 `case_hub_start_e2e`，不得修改选择。
- E2E 落地仓库、允许路径、Playwright config、project 与 automationPath 均由部署配置和仓库 Skill 决定，不从文字 Case 或用户文本指定。
- 单条和批量 action 都创建一个 Run；批量只产生一个 PR。
- 确定性 lifecycle 负责 sandbox、调用独立的 `qasey-e2e-author`、有限 repair、fresh verifier、artifacts、Draft PR 和逐 Case Review。
- fresh clean verifier 的 Playwright 失败先把真实失败摘要交给 Author 做有限次数的自动修复，再从全新 checkout 验证；只有完整通过才进入正常证据审核。
- 自动修复预算耗尽后必须以 `failed` 终止，保留失败诊断并明确下一责任方；不得把失败结果包装成可批准证据或继续发布 Draft PR。
- 创建成功只表示 run 已进入 lifecycle，不表示代码、验证或 PR 已完成。

返回真实 run ID、平台/框架、当前状态、查看入口和下一等待阶段。

## e2e_rerun：重跑

- 定位真实旧 run，确认 Change Set、仓库、framework 和可重跑条件。
- 创建新的 run，不复用旧 run ID、覆盖旧 artifacts 或顺带修改测试实现。

同时标明来源 run、新 run、当前状态、执行环境和 artifacts 或阻塞入口。

## e2e_repair：修复测试实现

- 用 `case_hub_get_case` 找到关联 run；可通过 `conversation_runs` 明确读取当前租户其他会话的 run，但不可读取其他会话消息。通过 `update_e2e_execution` 的 amend 提交实现修改；跨会话或已结束任务会创建归属当前会话的新 run，复用原批准文字版本。
- 读取失败 run、日志、trace、截图或视频及相关代码，区分产品缺陷、环境问题、locator/等待问题和断言失败。
- fresh verifier 的断言失败需要先诊断是否来自 locator、等待、数据准备或测试实现；可以在有限预算内修复这些测试问题。
- 产品缺陷或不可靠环境不得通过弱化断言伪装修复；证据表明不是测试实现问题时保留真实失败，预算耗尽后进入明确的失败结束状态。
- 修复仅限允许路径和测试实现，遵守有限 repair 次数；修复后必须进入 fresh clean verifier。

说明失败分类、修复范围、真实 run ID、当前验证状态、证据入口和仍需人工处理的问题。

## e2e_status：只读状态

- 使用真实 run ID 查询 run 与 timeline；需要精确结果时读取对应 artifacts。
- 区分 queued、running、repairing、clean_verifying、awaiting_qa、succeeded、failed 和 cancelled，不根据耗时推测。
- 不触发 rerun、repair、verdict、PR 更新或其他状态变化。

先给当前状态，再给最近关键事件、PR/artifact 链接、阻塞原因和下一责任方。
