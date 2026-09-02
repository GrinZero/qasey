---
name: e2e-lifecycle
description: 统一处理 Case Hub 与 E2E lifecycle：从需求提交候选 Case Change Set、生成 Playwright、逐 Case 审阅、重跑或查询状态与证据。
---

# E2E Lifecycle

System prompt 已识别的 intent 决定执行 `e2e_generate`、`e2e_rerun`、`e2e_repair` 或 `e2e_status` 模式。只执行请求对应的模式；状态查询不得顺带触发状态变化。

## 共享约束

- 首期只支持 Web Chromium Playwright；所有状态、结果和 artifacts 只以真实 lifecycle 事件为准。
- 不直接修改仓库、扩大允许路径、绕过 clean verifier、自动合并 PR，或用 Author workspace 的结果替代独立验证。
- 缺少关键 run、来源用例、仓库或执行条件时不猜测。

## e2e_generate：创建 run

- E2E Case 落地 Web 目标仓库固定读取部署方通过 `QASEY_E2E_REPOSITORY_CONFIG_FILE` 提供的、未提交到 Git 的配置，不得从用户文本选择、替换或扩大目标仓库和允许路径。
- Web 项目根目录、允许路径、Playwright config 和 project 名称都从该配置读取。Verifier 根据 patch 涉及的 project 选择 config；有具体变更 spec 时只验证这些 spec，否则验证受影响 project。
- 调用创建工具前，把当前消息、thread memory、附件及前序工具证据整理成结构化 handoff：目标、需求摘要、范围、已确认决策、约束、假设、关键流、边界、负向场景、数据需求、仓库发现、阻塞问题和证据引用。
- Case Hub 是结构化用例的唯一真相源；Git 只保存 Playwright，不保存 Case YAML。
- 有未解决的阻塞问题时先向用户澄清，不得启动 E2E。
- 先用 `case_hub_search_cases` 查重，再把 create/update proposal 与 Requirement Snapshot 一次性交给 `case_hub_create_change_set`。
- 每条 Case 必须有稳定 `QASEY-N` ID、完整步骤/预期、优先级、suite、tags 和 automationPath；更新必须引用现有 Case ID。
- 确定性 lifecycle 负责 sandbox、Native Mastra author、有限 repair、fresh verifier、artifacts、Draft PR 和逐 Case Review。
- 创建成功只表示 run 已进入 lifecycle，不表示代码、验证或 PR 已完成。

返回真实 run ID、平台/框架、当前状态、查看入口和下一等待阶段。

## e2e_rerun：重跑

- 定位真实旧 run，确认 Change Set、仓库、framework 和可重跑条件。
- 创建新的 run，不复用旧 run ID、覆盖旧 artifacts 或顺带修改测试实现。

同时标明来源 run、新 run、当前状态、执行环境和 artifacts 或阻塞入口。

## e2e_repair：修复测试实现

- 读取失败 run、日志、trace、截图或视频及相关代码，区分产品缺陷、环境问题、locator/等待问题和断言失败。
- 产品缺陷或不可靠环境不得通过弱化断言伪装修复；断言失败默认不是可自动 repair 的测试实现问题。
- 修复仅限允许路径和测试实现，遵守有限 repair 次数；修复后必须进入 fresh clean verifier。

说明失败分类、修复范围、真实 run ID、当前验证状态、证据入口和仍需人工处理的问题。

## e2e_status：只读状态

- 使用真实 run ID 查询 run 与 timeline；需要精确结果时读取对应 artifacts。
- 区分 queued、running、repairing、clean_verifying、awaiting_qa、succeeded、failed 和 cancelled，不根据耗时推测。
- 不触发 rerun、repair、verdict、PR 更新或其他状态变化。

先给当前状态，再给最近关键事件、PR/artifact 链接、阻塞原因和下一责任方。
