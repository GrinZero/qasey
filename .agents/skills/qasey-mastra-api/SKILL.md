---
name: qasey-mastra-api
description: 安全地检查或调用 Qasey 已认证的 Mastra API，包括本地开发运行时和 T2 部署环境。用于 Agent、Workflow、Tool、Memory、Thread、日志、Trace、指标、评分、调度、Studio API 调试、API 重放和运行时回归探测；如果只是普通代码修改且不需要调用正在运行的 Qasey 环境，则不要使用此技能。
---

# Qasey Mastra API

调用 Qasey 运行时 API 时，不要复制浏览器 Cookie，也不要暴露凭据。Trace 检查只是其中一种用途；所有 `/studio/api` 下受保护的 Mastra 路由都使用相同的目标环境选择和认证流程。

## 选择环境

- `local`：`http://localhost:4111`
- `t2`：`https://qasey.t2.moego.dev`
- 两个环境的 Mastra API 前缀都是：`/studio/api`

使用用户指定的环境，或根据 URL、日志、复现信息判断出的环境。不要在未说明的情况下同时查询两个环境。如果目标环境会实质性影响结果，且无法推断，应先询问用户要调用哪个环境。

## 安全加载凭据

始终通过标准加载器读取仓库环境文件，以确保 `.env.local` 和编码后的 `.env.secret` 按预期优先级生效：

```bash
pnpm exec moego-aws-secret-env run --default-environment testing -- <command>
```

绝不要打印、记录、粘贴到聊天中或提交 Token。只能检查 Token 是否存在。请求进程必须自行读取环境变量并在内部构造以下请求头：

```text
Authorization: Bearer <token>
```

### T2

读取 `QASEY_DEBUG_TOKEN`，用于 `https://qasey.t2.moego.dev`。这是租户 API Token，每次调用仍受签发 Token 时选择的 scope 限制。常见的读取 scope 包括：

- `platform.runtime.inspect`：可观测性及其他运行时检查路由
- `platform.catalog.read`：Agent、Workflow 和 Scorer 目录读取
- `platform.background-tasks.read`、`platform.internal-workflow.read` 或 `platform.schedules.read`：对应的平台功能
- Admin Token 签发器暴露的特定应用 scope

不要假设 `platform.runtime.inspect` 能授权所有 Mastra API。某些执行或管理权限无法签发给租户 API Token。权限拒绝可能有意返回 `404`，因此应结合路由分类、当前 Token scope 和审计证据，区分“路由或资源不存在”和“Token scope 不足”。

如果 `QASEY_DEBUG_TOKEN` 不存在或为空，应停止操作，并告知用户打开 [T2 Admin](https://qasey.t2.moego.dev/admin)，创建包含目标调用所需 scope 的 API Token，复制一次性 Token 值，然后将其保存到 Git 忽略的 `.env.local` 中，变量名为 `QASEY_DEBUG_TOKEN`。读取 Trace/runtime 数据时，应包含 `platform.runtime.inspect`。不要代用户创建或轮换 Token。

### Local

从 Git 忽略的 `.env.local` 读取 `QASEY_DEV_AUTH_TOKEN`。它会解析为租户 `local-development` 中由服务器管理的 `local-developer` 身份，并拥有 `platform-admin` 权限。仅当本地服务器以 `NODE_ENV=development` 运行时有效；测试会忽略它，生产环境会拒绝它。如果缺少该变量，应让用户在 `.env.local` 中添加一个至少 32 个字符的随机值，例如在本地使用 `openssl rand -hex 32` 生成。

如果用户明确提供了 `qasey_session` Cookie，可以在该次请求中使用；否则不要复制浏览器 Cookie。浏览器 Admin UI 和 Studio 导航仍使用 Google OAuth；绝不要把调试/开发 Token 编译进前端代码或静态构建产物。

Bearer 认证适用于受保护的 Admin、普通 API 和 Studio API，但不能替代 Slack 或 Jira 请求签名。对于应验证 Slack/Jira 签名的渠道 Webhook 重放，绝不要附加该 Bearer Token。

## 调用 Mastra API

实际发起本地/T2 请求时，使用随技能提供的客户端。它会在内部读取正确的 Token，并且只访问所选环境的 `/studio/api` 前缀：

```bash
# 目录和运行时读取。
pnpm exec moego-aws-secret-env run --default-environment testing -- \
  node .agents/skills/qasey-mastra-api/scripts/studio-api.mjs t2 GET /agents

pnpm exec moego-aws-secret-env run --default-environment testing -- \
  node .agents/skills/qasey-mastra-api/scripts/studio-api.mjs local GET /workflows/qasey-task-workflow/runs \
  --query '{"limit":10,"offset":0}'

# 对明确获得授权的写入/执行调用，不要把 JSON 放进命令行参数。
pnpm exec moego-aws-secret-env run --default-environment testing -- \
  node .agents/skills/qasey-mastra-api/scripts/studio-api.mjs local POST /agents/qasey-main/generate \
  --body-file /absolute/path/to/request.json
```

使用 `--help` 查看客户端的全部选项。查询 JSON 可以通过 `--query` 传入；请求体必须来自 `--body-file` 或 `--body-stdin`，这样 prompt 和其他负载不会进入命令参数。

诊断时默认只进行读取调用。用户要求检查或调试，并不等于授权执行 Agent、启动/恢复/取消 Workflow、修改调度、写入评分、删除数据或进行其他副作用操作。只有当用户明确将该操作纳入范围时，才使用会修改状态的方法；除非已知操作具有幂等性，否则不要重试失败的修改请求。

## 发现已安装的 API

不要凭记忆猜测路由路径或负载格式。Qasey 固定使用特定 Mastra 版本，应以运行中的服务器 schema 或已安装的 CLI/源码为准。

只检查匹配的路由，不要倾倒完整 schema：

```bash
pnpm exec moego-aws-secret-env run --default-environment testing -- \
  node .agents/skills/qasey-mastra-api/scripts/studio-api.mjs t2 GET /system/api-schema \
  | jq '.routes[] | select(.path | contains("/memory")) | {method, path, pathParamSchema, queryParamSchema, bodySchema}'
```

仓库中的 `mastra` 技能，以及 `mastra api <resource> <action> --help|--schema`，可用于了解资源语义和发现本地命令。不要通过 CLI 的 `--header` 选项传入 `QASEY_DEBUG_TOKEN` 或 `QASEY_DEV_AUTH_TOKEN`，因为这样会把密钥放入进程参数；经过认证的 Qasey 调用应使用 `studio-api.mjs`。

分页列表应保持较小，并在读取完整响应前先用 `jq` 投影字段。只有确实需要时，才获取完整 Trace、Span、消息、prompt 或输出。所有响应都可能包含敏感信息：应脱敏密钥和个人数据，不要把完整 prompt、Authorization/Cookie 请求头、OAuth 负载或附件粘贴到聊天或日志中。

汇报结果时，说明检查的环境和路由，明确区分 API 直接观测到的证据与推断，并优先报告稳定 ID 和时间戳，而不是完整负载。
