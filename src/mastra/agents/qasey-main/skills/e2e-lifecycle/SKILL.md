---
name: e2e-lifecycle
description: 统一处理 E2E lifecycle：从已验收 QA 用例生成新 run、重跑已有 run、依据失败证据修复测试实现，或只读查询 run 状态与 artifacts。
---

# E2E Lifecycle

System prompt 已识别的 intent 决定执行 `e2e_generate`、`e2e_rerun`、`e2e_repair` 或 `e2e_status` 模式。只执行请求对应的模式；状态查询不得顺带触发状态变化。

## 共享约束

- Web 使用 Playwright，App 使用 Maestro；所有状态、结果和 artifacts 只以真实 lifecycle 事件为准。
- 不直接修改仓库、扩大允许路径、绕过 clean verifier、自动合并 PR，或用 Author workspace 的结果替代独立验证。
- 缺少关键 run、来源用例、仓库或执行条件时不猜测。

## e2e_generate：创建 run

- 确认来源用例、平台、仓库、base ref、允许修改路径和运行前置条件。
- 通过发现到的 E2E 创建工具启动 run；确定性 lifecycle 负责 workspace、author、有限 repair、clean verifier、artifacts、Draft PR 和 QA verdict。
- 创建成功只表示 run 已进入 lifecycle，不表示代码、验证或 PR 已完成。

返回真实 run ID、平台/框架、当前状态、查看入口和下一等待阶段。

## e2e_rerun：重跑

- 定位真实旧 run，确认仓库、framework、来源用例和可重跑条件。
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
