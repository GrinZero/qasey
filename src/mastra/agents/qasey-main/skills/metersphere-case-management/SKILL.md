---
name: metersphere-case-management
description: 管理 MeterSphere 测试用例的统一流程，覆盖从零全量创建，以及对已有用例的增量修改、补充、纠正、重组或重试写入。
---

# MeterSphere 测试用例管理

System prompt 已识别的 intent 决定执行 `case_create_full` 或 `case_maintain_fast` 模式。不要在本 Skill 内重新发明第三种模式。

## 共享约束

- MeterSphere 核心能力由运行时直接提供，不通过 `search_tools` 发现：使用 `metersphere_ms_list_modules`、`metersphere_ms_list_test_cases`、`metersphere_ms_get_test_case_detail`，以及仅用于唯一一次预检的 `metersphere_ms_bulk_upsert_test_cases(dry_run=true)`。
- 需要核心能力之外的 MeterSphere 操作时必须先调用 `search_tools`。尤其当目标模块不存在、需要创建或更新模块时，使用同时包含 `MeterSphere`、`module` 和 `create` 或 `upsert` 的具体关键词搜索；发现 `metersphere_ms_upsert_module` 后按其 schema 执行。完成搜索且未发现相应工具之前，不得声称“当前工具集没有该能力”。
- 如果上述任一必需工具不可用，立即把它作为运行时能力 blocker 返回；不要改写关键词、搜索同义词或用 Slack/Jira 结果替代 MeterSphere 的真实读取与回执。
- 当前需求、设计与实现事实优先；历史经验仅作为风险线索。冲突时保留证据，不擅自补全产品决策。
- 每条待写用例都要有明确目的、前置条件、可执行步骤、可观察预期和简短 QA reasoning；每条用例选择 1–3 条直接支撑的稳定来源。
- 未知规则标为待确认；无证据的猜测不得进入待写计划，也不得重复创建语义等价用例。
- 写入前核对目标项目、模块、字段与 create/update 集合，只调用一次 `dry_run=true` 的批量预检冻结不可变 CasePlan。
- CasePlan 冻结后停止工具操作并交还运行时；不得直接执行真实 case mutation 或删除。确定性 Workflow 负责真实写入、新鲜 detail 回查和 completion checkpoint。
- 只有 plannedCount 全部通过 fresh read-back receipt 才能声称完成；没有 receipt 时不得声称已写入。
- 过程消息只用于真实证据、风险、决策或阻塞变化；任务较长时，完成第一个有信息增量的阶段后至少报告一次，不按内部步骤逐项打卡。

## case_create_full：全量创建

1. 读取 QA Context，确认需求范围、目标角色、关键状态、配置或 Flag、外部依赖、非目标和未解决问题。
2. 按相关性核对需求/设计、代码或 PR、讨论、已有用例和历史经验。
3. 先收敛风险和覆盖模型，再形成 canonical cases；覆盖适用的正常路径、反向状态、边界数据、权限、异步副作用、失败恢复与回归影响。
4. 合并仅输入不同但本质相同的重复用例；每条用例保留一至三条直接证据。

最终说明需求、核心风险、覆盖维度、真实新增/更新/回查数量、MeterSphere 位置和待确认项。

## case_maintain_fast：增量维护

1. 读取 QA Context，定位用户指向的已有分析、artifact、模块和用例；无法确定维护对象时只问一个聚焦问题。
2. 比较当前请求与既有事实，列出新增、修改、失效和保持不变的内容；只补充会改变维护决策的证据。
3. 保留仍有效的用例 ID、结构和证据，不以全面重写代替局部维护。
4. 找不到原对象、目标模块或可靠差异时返回 blocker。

最终说明维护依据、真实新增/修改/未改内容、回查数量、目标位置和待确认项。
