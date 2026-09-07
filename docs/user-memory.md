# 用户记忆与跨会话回忆

Qasey 在同一租户内为同一用户保存长期偏好，并按需读取其私有历史会话。
需要配置 PostgreSQL；复用现有 Mastra 存储，无新增数据表或 embedding 依赖。

## 两层 Working Memory

- 会话级：保留现有 `workingMemory.scope: "thread"` 和 thread 级 Observational
  Memory。Observer 继续维护当前 QA 任务的目标、决策、进度和阻塞。
- 用户级：通过 Mastra `getWorkingMemory` / `updateWorkingMemory` 的 resource
  scope 读写同一用户的偏好。Processor 每个模型步骤加载最新内容，独立工具负责更新，
  不由会话 Observer 自动提取或覆盖。用户资料只注入系统上下文，不追加到聊天记录。

`read_user_memory` 返回当前偏好和 `revision`；`update_user_memory` 支持：

- `set`：按 key 新增或替换一个偏好，需要 value。
- `forget`：按 key 删除一个偏好。
- `clear`：用户要求时清空全部偏好。

更新必须传入 `expectedRevision`。数据库 advisory lock 将不同进程对同一用户的
读改写串行化；版本冲突或锁忙时返回错误，调用方重新读取后再应用修改。
每条偏好记录更新时间和来源会话，最多 30 条，每条值最多 500 字符。
未知格式的已有 resource 记忆会报错并保留原值，不自动覆盖。

例如：“以后用中文写用例”可以保存为 language 偏好；“当前支付需求还有三个阻塞”
属于会话记忆。当前用户要求优先于历史偏好。记忆内容不构成操作授权。
删除偏好不会删除历史消息，Agent 不应从旧消息自动恢复已经删除的偏好。

## 跨会话回忆

OM 仍为 thread scope，`observationalMemory.retrieval.scope` 扩展为 resource。
Mastra 原生 `recall` 支持列出会话，以及分页读取选定会话的原始消息；即使旧会话
还没有生成 observations，也能读取已有消息。用户说“继续上次的需求”时，先发现
相关会话，再读取具体决策；回答注明来源会话和时间，并区分历史状态和当前事实。

本版未启用向量语义搜索，也不会把所有会话摘要自动注入当前任务。

## 身份、共享会话和 Studio

用户记忆 resource 复用可信入口生成的 `application + tenant + user` 标识。
工具参数不接受 userId、tenantId 或 resourceId。只有已认证的私有 API/Web 请求
可以读取和更新个人记忆；Slack、Jira、worker 和共享频道不注入个人资料。
共享会话的 recall 仍受其原有共享 resource 限制。

两个工具通过 Qasey 的 `tools/` 文件约定注册，Studio 可发现、可直接执行。
Studio 使用正常认证身份及 Mastra 生成的 thread，不需要额外的私有 runtime binding。
未配置 PostgreSQL 时不注入用户记忆，工具明确报告持久化存储不可用。

原有 thread Working Memory 和消息无需迁移；用户级资料从空记录开始积累。
