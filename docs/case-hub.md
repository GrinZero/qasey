# Qasey Case Hub

Case Hub is the sole source of truth for manual test cases. Git stores only the
Playwright implementation. The first release has one project (`QASEY`), Web,
Chromium, and a strict one-test-to-one-case mapping.

## Two independent quality gates

The Agent first creates a `CaseReviewPlan` in the current conversation and
Mastra thread. Its mutable `CaseReviewItem` rows are drafts, not Case Versions
and not E2E work. The creator can edit every business field, reorder steps,
remove or restore rows, and approve rows independently. Other users in the same
tenant may read the plan but cannot mutate it or continue the creator's session.

Approval is the formal text-case boundary. A single approval atomically assigns
the next `QASEY-*` ID for a create, writes an immutable Case Version, and makes
that version active. Batch approval validates every row and revision before it
commits anything. Editing an approved row turns the row back into a pending
revision; its previous formal version remains active until the new revision is
approved. Removing a Review row never deletes a formal Case.

An active text Case is listed in Case Hub even when it has no automation. The
version-level automation state is `none`, `generating`, `awaiting_review`,
`verified`, `failed`, or `stale`. The read-only system tag `e2e` is derived only
from approved video/Trace evidence for that exact Case Version and is separate
from user tags. A newly approved text version never inherits an older version's
evidence; it is shown as `stale` / “E2E 待更新” until new evidence is approved.

## Change lifecycle

1. The Agent freezes the conversation as a redacted Requirement Snapshot,
   searches existing coverage, and calls `case_hub_create_review_plan`.
2. The shared Review UI loads the plan by stable ID in both chat and Case Hub.
3. A user approves text rows. This does not create a Run or touch Git.
4. “Generate this case” or “Next” sends a typed `generate_e2e` conversation
   action to the original conversation. The runtime checks the creator, thread,
   plan, and exact active Case Version IDs before `case_hub_start_e2e` can run.
5. A single selection creates one automation-only Change Set, one Run, and one
   eventual PR. The E2E Author chooses paths from repository policy and the
   independent verifier checks exact `qasey.case` / `qasey.version` mappings.
6. A fresh verifier applies the patch and emits JSON/HTML reports, traces,
   screenshots, and videos configured by the target repository.
7. Reviewers decide each latest Result independently: approve, request changes,
   product bug, or environment issue.
8. A requested change carries only that Case Version into the next Attempt.
9. Once every latest Result is approved, the Draft PR becomes Ready and the
   exact text version gains the derived `e2e` tag. Qasey does
   not merge it.
10. A signed, delivery-id-deduplicated GitHub webhook marks the automation
   delivery merged. It never changes the active text Case Version. Closing
   without merge abandons the coverage. A
   service-only `POST /internal/case-hub/change-sets/:id/reconcile` endpoint
   actively reconciles missed pull-request deliveries.

Results are append-only. A rerun creates a new Attempt and never overwrites old
evidence. Product and environment blockers do not trigger assertion weakening.
The legacy proposal-and-start tool and direct Change Set/Run creation endpoints
return `text_case_review_required` and cannot bypass the text review gate.

## Admin task conversations

`/admin/apps/qasey` is a persistent QA task conversation rather than a one-shot
prompt. Each conversation has a tenant-and-subject-owned Mastra thread/resource,
one active turn at a time, and a replayable event sequence. The Admin UI uses:

- `GET|POST /v1/qasey/conversations` to list and create tasks;
- `GET /v1/qasey/conversations/:conversationId` to restore a deep link;
- `POST /v1/qasey/conversations/:conversationId/messages` for an idempotent
  `clientMessageId` and AI SDK v7 UI Message Stream response;
- `POST /v1/qasey/conversations/:conversationId/actions` for an idempotent,
  typed `generate_e2e` turn in the same thread;
- `GET /v1/qasey/conversations/:conversationId/turns/:turnId/events` to resume
  after the last received sequence.

The database retains the internal `accepted`, `assistant.delta`, `progress`,
`tool.started`, `tool.finished`, `review-plan.linked`, `run.linked`, `completed`, and `failed` event
log. API reads project that log into stable `QaseyUIMessage` records, while live
responses expose text, curated `data-progress`, native dynamic-tool lifecycle
parts, stable `data-case-review` references, `data-run`, and hidden
`data-cursor` parts. Business-relevant tools expose
their technical name plus bounded input/result summaries; progress-reporting and
clock utilities stay hidden. Raw tool arguments, raw results, credentials,
internal errors, and reasoning never cross the conversation API.
The browser uses the cursor to request only missing events; closing the browser
does not cancel the durable Agent execution. Once a turn links an E2E run, the
Admin UI follows the separate run event stream until a terminal state.
`/v1/qasey/tasks` remains available as an isolated one-shot compatibility
endpoint. The retired `/admin/apps/qasey/workspace` route intentionally returns
the Admin 404 view; backend sandbox/runtime APIs remain available for automation
and existing integrations.

## Following an E2E task from Case Hub

Case Hub requests an `application/json` acknowledgement from the conversation
`actions` endpoint. Acceptance returns the persisted conversation and turn IDs
immediately; chat clients continue to use the existing event stream. The
accepted event atomically stores the selected Case IDs, exact version IDs,
version numbers and titles. Retrying an uncertain request reuses its client
message ID rather than creating another turn.

“查看 Agent 工作” opens that exact turn without automatically navigating away
from Case Hub. The chat highlights the turn and displays its saved Case context
with a return link. Plan reads restore task links for the conversation owner;
other viewers do not receive private conversation task links. Older turns without
this context still use the original conversation entry. Task completion is
separate from E2E evidence approval.

## One-time cutover

Migration `20260904170000_add_text_case_review_gate` clears the old Case Result,
Case Version, Case, and Case Change Set projection in dependency order and
resets every QASEY number sequence to `1`. It does not delete conversations,
turns, Run/Event records, or artifacts. A historical Run whose old Case Hub
link no longer resolves is still readable and is labelled “旧 Case Hub
数据已清理”; invalid Case actions are not offered. The cleanup is part of this
single migration and is not repeated for data created by the new model.

## Test environment and login

The build automatically stamps the checked-out Git commit into a runtime
artifact. The Workflow freezes that observed value on the Change Set and blocks
when it differs from the repository base SHA; callers cannot submit or override
it. Generic target verification uses the target repository's checked-in
Playwright setup project. Qasey supplies `BASE_URL` and only the secret variable
names declared by the repository configuration to the non-Agent verifier. The
setup performs the login and owns any storage-state file under an ignored test
output path. Those variables do not enter prompts, Change Set JSON, logs, PRs,
or artifacts.

The target repository's project Skill identifies the test-account class,
role/tenant, login route, setup file, and cleanup rules. Qasey's Sandbox verifier
receives the declared variables from the deployment secret source and runs the
configured Playwright project. The internal `/internal/e2e/leases` API is
reserved for explicit Qasey service tests and is not used to authenticate an
arbitrary target product.

## Native CodeTask rollout

API, orchestration worker, and sandbox images must be deployed together. Before
the switch, stop new CodeTasks and drain active author, repair, and verifier
attempts. Mark timed-out attempts `lost`; keep their artifacts read-only and
create a fresh Native Attempt on the same Run. Do not restore an old agent
session.

The sandbox `/readyz` response must advertise only the `native-mastra`
capability before intake resumes. `pnpm check:native-code-task` rejects legacy
agent protocol packages, commands, environment variables, and provenance fields
from tracked source, manifests, and the lockfile.

## 会话内协作与 E2E 反馈

Web 工作台支持具名的会话参与者。默认消息交给 Qasey；输入 `@` 从已加入的参与者中选择一个或多个接收者，消息通过结构化 `recipientAgentIds` 路由。文本、引用和附件中的 `@` 字样不会派发执行。点击作者可以指定参与者及其关联任务；多个 E2E 运行存在歧义时必须选择目标。

后台协作使用 `conversation_collaboration` 持久化邮箱，保存参与者、具名消息、每个收件人的处理记录、关联 run 和执行补充。收件人独立完成或失败，同一参与者的普通问答顺序执行。Agent 可通过 `delegate_agent` 委派并收到回执；每条用户消息最多 8 次委派、4 层嵌套。Mastra 使用按参与者隔离的记忆线程，并显式传递带作者和接收者的共享历史。

`POST /v1/qasey/conversations/:conversationId/messages` 接受 `recipientAgentIds` 和可选 `targetRunId`；JSON 调用返回 202 及 delivery IDs。`GET /v1/qasey/conversations/:conversationId/events?after=…` 提供会话级 SSE 快照和持久化 revision。快照包含所有已保存消息以覆盖断线期间的变化，客户端替换而非追加；旧的逐 turn SSE 接口继续兼容。历史消息默认归属 Qasey，历史 run 只展示当前状态，不生成过去的 Agent 对话。

E2E lifecycle 的关键状态仍按事件 ID 去重保存，Web 会话按 run 聚合为一个位置稳定、持续更新的进度区，不再逐条渲染为 Agent 聊天。执行记录默认折叠，结束时收起；历史状态也采用相同展示。失败保留可读结论，原始错误和证据通过“查看详情”按需查看；未知的历史阶段不会显示为已完成。

编写 Agent 的面向用户分析摘要通过 CodeTaskResult.analysisSummary 独立于诊断日志保存，在编写结束后送回会话，说明实际发现、实现选择和自检范围。独立验证按真实的结构化检查结果汇报通过与失败情况，不把自检或自动验证等同于人工批准。摘要沿用事件去重机制，不触发额外委派；旧任务没有摘要时不补造分析。聊天默认不列出证据文件、原始日志和内部任务编号，原始材料继续保留在运行详情。

执行补充记录 pending / applying / applied 及 author attempt。要求在下一次编写节点读取，应用后必须重新独立验证；交付前原子检查待应用要求。交付之后的修改创建独立 Change Set 和后续 Run，不覆盖旧记录。修改文字步骤、预期或范围仍需回到文字审核。取消动作直接控制已有 lifecycle，不等待 Author 完成。

部署前运行数据库迁移以创建邮箱表；协作 worker 在 standalone / orchestration 角色启动，并通过 readiness 暴露健康状态。排队工作可恢复；已丢失执行租约的问答标记失败，避免重放结果不确定的外部写入。底层 E2E 继续通过自己的生命周期恢复与状态投递。首版仅接入 Web 工作台，Slack 的原生 mention 保持原有行为。


### 删除正式用例

在用例库每行的“更多操作”菜单中选择“删除用例”，组件确认弹窗会展示 Case ID 与完整标题。弹窗默认聚焦“取消”；删除时禁用重复操作，失败提示留在弹窗内以便重试。删除后用例退出列表、搜索和详情，也不能用于新建 E2E Change Set。接口为 `DELETE /v1/case-hub/cases/:caseId`，要求 `qasey.cases.write` 权限，并按 application 与 tenant 隔离；重复删除返回成功，不存在的用例返回 404。

删除采用软删除，保留 Case ID、历史版本、Change Set 和执行证据；已有自动化文件不会被删除，已有任务也不会因此取消。部署前需执行数据库迁移，增加 `qasey_cases.deleted_at` 字段。
