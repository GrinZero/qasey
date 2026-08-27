# Qasey

Qasey 是一个可自托管的 QA Agent Application，同时提供可承载更多 Agent
Application 的 Mastra Runtime。平台层统一负责身份、权限、RequestContext、
存储、可观测性、MCP、Workspace 与进程生命周期。

项目只依赖公开软件包。PostgreSQL 可以使用本地 Docker、Supabase 或任何兼容
服务；外部 MCP、Slack、Jira、GitHub 和 Datadog 均为可选集成。

Qasey 采用 [Apache License 2.0](./LICENSE) 开源。

Render 用户可以直接从仓库根目录的 [`render.yaml`](./render.yaml) 创建
Blueprint；发布仓库 URL 确定后，再由维护者添加绑定该 URL 的部署按钮。

## 本地运行

```bash
corepack enable
sh scripts/bootstrap.sh
pnpm dev
```

脚本会从 [`.env.example`](./.env.example) 创建被 Git 忽略的 `.env`，启动本地
PostgreSQL/Redis 并执行 Prisma migration。首次运行后应按需要填写模型密钥；
未配置的外部集成保持关闭。打开 `/admin` 后可直接注册密码账号；单租户生产环境
也默认开放该入口，公开部署可设置 `QASEY_PASSWORD_REGISTRATION_ENABLED=false`
关闭自助注册。详细说明见 [部署文档](./docs/deployment.md)。

`pnpm dev` 提供完整本地能力：它构建 Admin UI 与 CodeTask worker，启动单副本本地 Sandbox，等待 `:4120/readyz` 通过后再启动 Mastra。E2E author、repair 和 clean verifier 都走与部署环境相同的 CodeTask Runner 路径；退出开发进程时两边的进程树会一起终止。默认监听 Mastra 的本地端口。所有环境都在 `/studio` 提供受浏览器登录、RBAC 与审计保护的 Studio，其原生 API 统一位于 `/studio/api`；Editor 与 MCP Preview 等高风险能力仍由独立开关控制。`/admin` 是面向多 Agent 产品用户的管理界面，不是 Studio 的替代实现；它只通过已注册 Application 的受控 API 使用 Mastra 能力。

- Agent：`POST /studio/api/agents/qasey-main/generate`、`/stream`
- Workflow：`POST /studio/api/workflows/qasey-e2e-lifecycle/start`、`/resume`
- Qasey Run：`GET|POST /v1/runs` 与 owner-scoped 子资源
- Slack（Admin UI 管理）：`POST /channels/slack/apps/:webhookId/events`
- Slack（兼容原有环境变量配置）：`POST /studio/api/agents/qasey-main/channels/slack/webhook`
- Jira：`POST /webhooks/jira`（签名后直接进入原生 Agent）
- Probes：`GET /`（Studio 实例发现）、`GET /healthz`、`GET /readyz`

生产异步执行使用 Mastra 官方 Split Workers。

## 配置

分布式生产部署必需：

- `DATABASE_URL`
- 单租户默认开启密码注册与登录；也可配置完整的 Google OIDC，或显式设置 `QASEY_PASSWORD_AUTH_ENABLED=false` 关闭密码登录
- `REDIS_HOST`、`REDIS_PORT`、`REDIS_PASSWORD`、`REDIS_TLS=true`
- `WORKER_TOKEN`：API 与 Mastra orchestration Worker 共用、至少 32 UTF-8 字节的随机专用身份密钥；
  容器入口会将其映射为 Mastra 标准的 `MASTRA_WORKER_AUTH_TOKEN`
- `QASEY_SANDBOX_ENDPOINT_TEMPLATE`：固定 Sandbox Pool 地址，必须包含 `{ordinal}`
- 模型 provider 配置

常用可选：

- `PLATFORM_BOOTSTRAP_ADMIN_EMAILS`：逗号分隔的 break-glass 管理员
- `PLATFORM_SERVICE_TOKEN`：至少 32 UTF-8 字节、且与 Worker/隧道/Webhook 凭据分离的服务身份 Bearer token
- Admin UI 的“触发器”通过通用 TriggerProvider registry 管理外部事件来源与 Agent/Workflow 绑定；Slack 是首个 provider，可保存多个已安装的 Slack App 并获取稳定 Webhook URL。Bot Token 与 Signing Secret 会在服务端加密保存，不需要配置 `SLACK_*` 环境变量
- `SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`；本地 Socket Mode 可用 `SLACK_SOCKET_MODE_APP_TOKEN`（仅用于兼容原有单 App 配置）
- `JIRA_BASE_URL`、`JIRA_EMAIL`、`JIRA_API_TOKEN`、`JIRA_WEBHOOK_TOKEN`
- `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`：GitHub App installation authentication
- `QASEY_MCP_CONFIG_FILE`、`QASEY_MCP_OAUTH_DIR`；MCP 默认不配置，只有
  `QASEY_REQUIRE_METERSPHERE_MCP=true` 时静态单租户 MeterSphere 才参与 readiness 门禁；
  multi 模式仅允许静态 subject-bound OAuth，Bearer MCP 必须保存为租户加密外部连接
- `MASTRA_ENCRYPTION_KEY`、`MASTRA_ENCRYPTION_ACTIVE_KEY_ID` 与
  `MASTRA_ENCRYPTION_PREVIOUS_KEYS`：OAuth MCP token 的独立版本化 keyring；生产启用
  OAuth MCP 时需要，并支持 read-old/write-new 与启动时 CAS 重加密
- `QASEY_ENABLE_CODE_MODE`：启用基于 QuickJS 隔离运行时的只读工具编排（默认关闭）；可用 `QASEY_CODE_MODE_TIMEOUT_MS` 和 `QASEY_CODE_MODE_MEMORY_LIMIT_MB` 限制单次执行
- `QASEY_ENABLE_LOCAL_CODE_MODE`：仅为开发 Workspace 开启 LocalSandbox；Code Mode 自身不依赖宿主机或远程 sandbox
- 社区构建不分发 Mastra Studio Editor；`QASEY_ENABLE_STUDIO_EDITOR=true` 或
  `EDITOR_DATABASE_URL` 会在启动时被拒绝。Studio MCP Preview 默认关闭。
- `QASEY_ENABLE_DATADOG`、`DD_LLMOBS_ML_APP`：启用 Mastra Datadog Bridge。集群默认通过 Datadog Agent 上报；本地没有 Agent 时可设置 `DD_LLMOBS_AGENTLESS_ENABLED=true`、`DD_SITE` 并通过密钥环境注入 `DD_API_KEY`。Slack dev Runtime tunnel 会传播 Datadog/W3C trace carrier，使云端入口和本地 Agent/LLM/Tool span 保持在同一条 trace 中

样例中的 `gpt-5.6-luna`（低成本 Memory 工作负载）和
`gpt-5.6-sol`（Agent 与代码任务）都是公开的 OpenAI Responses API
[模型 ID](https://developers.openai.com/api/docs/models)，可通过
`QASEY_MEMORY_MODEL` 和 `QASEY_CODE_AGENT_MODEL` 覆盖。Qasey 不依赖 Codex
应用内部的模型别名。

本地开发默认把 Observability 写入 `QASEY_OBSERVABILITY_DB_PATH` 指向的 DuckDB；即使本机通过拆分 PG 配置连接共享应用数据库，也不会隐式初始化远端 Observability schema。确需联调时可显式设置 `OBSERVABILITY_DATABASE_URL`。standalone 生产模式复用 `DATABASE_URL`，distributed 模式可使用独立的 PostgreSQL Observability 数据库。

本地脚本或 API 客户端不需要复制浏览器 Cookie。可在被 Git 忽略的 `.env.local` 中配置一个至少 32 字符的 `QASEY_DEV_AUTH_TOKEN`，然后发送标准 Bearer 请求头：

```bash
curl -H "Authorization: Bearer $QASEY_DEV_AUTH_TOKEN" \
  http://localhost:4111/studio/api/agents
```

该 token 只在 `NODE_ENV=development` 生效，并映射为服务端固定的 `local-developer` / `local-development` 开发管理员身份；请求不能自行指定 user、tenant 或 role。测试环境会忽略它，生产环境若出现该配置会直接拒绝启动。浏览器界面仍使用正常的 HttpOnly 会话 Cookie，避免把开发 token 暴露进前端产物。

MCP 示例见 [config/mcp.example.json](./config/mcp.example.json)。复制为被忽略的
`config/mcp.json` 后再启用（其中的静态 Bearer 示例仅适用于 single 模式）。
multi 模式的租户 Bearer MCP 配置见
[配置文档](./docs/configuration.md#tenant-owned-mcp-connections)。OAuth MCP 登录：

```bash
pnpm mcp:login figma
```

OAuth credential namespace 使用 application/tenant/subject/server，旧 namespace 不迁移。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
pnpm check:open-source
# 或
pnpm check
```

根构建和测试包含 `apps/admin-ui`。`pnpm build` 同时生成 `.mastra/output` API artifact 和 `.mastra/worker` 官方 Worker artifact。`pnpm test:browser` 需要额外安装 Chromium；它不嵌入 `pnpm check`，但 CI 与 release workflow 会显式执行并在失败时保留证据。

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [Adding an Application](./docs/adding-application.md)
- [Permissions](./docs/permissions.md)
- [Workspace and durability](./docs/workspace-and-durability.md)
- [Code Task Runner](./docs/code-task-runner.md)
- [Deployment](./docs/deployment.md)
- [Configuration reference](./docs/configuration.md)
- [Optional Slack integration](./deploy/slack/README.md)
- [Open-source migration](./docs/open-source-migration.md)
- [Public release procedure](./docs/public-release.md)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Production readiness and remaining GA evidence](./docs/production-readiness.md)

## 数据迁移

首次公开版本采用 fresh schema，不自动读取任何历史私有部署数据。现有部署迁移
前必须盘点并备份数据，使用脱敏导出和显式 migration，禁止把原始租户数据复制
到公开环境。
