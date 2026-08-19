# Shared Mastra Runtime

本仓库提供一个可承载多个 Agent Application 的 Mastra Runtime。Qasey 是第一个业务 Application；平台层统一负责 OAuth、权限、RequestContext、Composite Store、Observability、MCP、Workspace 与进程生命周期。

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm dev
```

默认监听 Mastra 的本地端口。所有环境都在 `/studio` 提供受 Google OAuth、RBAC 与审计保护的 Studio，其原生 API 统一位于 `/studio/api`；Editor 与 MCP Preview 等高风险能力仍由独立开关控制。`/admin` 是面向多 Agent 产品用户的管理界面，不是 Studio 的替代实现；它只通过已注册 Application 的受控 API 使用 Mastra 能力。

- Agent：`POST /studio/api/agents/qasey-main/generate`、`/stream`
- Workflow：`POST /studio/api/workflows/qasey-e2e-lifecycle/start`、`/resume`
- Qasey Run：`GET|POST /v1/runs` 与 owner-scoped 子资源
- Slack：`POST /studio/api/agents/qasey-main/channels/slack/webhook`
- Jira：`POST /webhooks/jira`（签名后直接进入原生 Agent）
- Probes：`GET /`（Studio 实例发现）、`GET /healthz`、`GET /readyz`

`/v1/qasey`、`/v1/triggers`、`/webhooks/n8n`、独立 Bolt receiver、自建 queue worker 和 outbox 已删除。生产异步执行使用 Mastra 官方 Split Workers。

## 配置

生产必需：

- `DATABASE_URL`、`OBSERVABILITY_DATABASE_URL`
- `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_COOKIE_PASSWORD`
- `REDIS_HOST`、`REDIS_PORT`、`REDIS_PASSWORD`、`REDIS_TLS=true`
- `WORKER_TOKEN`：API 接受的专用 Mastra orchestration Worker token
- 模型 provider 配置

常用可选：

- `PLATFORM_BOOTSTRAP_ADMIN_EMAILS`：逗号分隔的 break-glass 管理员
- `PLATFORM_SERVICE_TOKEN`：服务身份 Bearer token
- `SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`；本地 Socket Mode 可用 `SLACK_SOCKET_MODE_APP_TOKEN`
- `JIRA_BASE_URL`、`JIRA_EMAIL`、`JIRA_API_TOKEN`、`JIRA_WEBHOOK_TOKEN`
- `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`：GitHub App installation authentication
- `QASEY_MCP_CONFIG_FILE`、`QASEY_MCP_OAUTH_DIR`
- `MASTRA_ENCRYPTION_KEY`：仅在生产启用 OAuth MCP token 持久化时需要
- `QASEY_ENABLE_LOCAL_CODE_MODE`：仅开发 LocalSandbox；生产未配置 remote sandbox 时 fail closed
- `QASEY_ENABLE_STUDIO_EDITOR`、`QASEY_ENABLE_STUDIO_MCP_PREVIEW`：生产默认关闭
- `QASEY_ENABLE_DATADOG`、`DD_LLMOBS_ML_APP`

本地开发默认把 Observability 写入 `QASEY_OBSERVABILITY_DB_PATH` 指向的 DuckDB；即使本机通过拆分 PG 配置连接共享应用数据库，也不会隐式初始化远端 Observability schema。确需联调时可显式设置 `OBSERVABILITY_DATABASE_URL`。生产仍使用独立的 PostgreSQL Observability 数据库。

MCP 示例见 [config/mcp.example.json](./config/mcp.example.json)。OAuth MCP 登录：

```bash
pnpm mcp:login figma
```

OAuth credential namespace 使用 application/tenant/subject/server，旧 namespace 不迁移。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
# 或
pnpm check
```

根构建和测试包含 `apps/admin-ui`。`pnpm build` 同时生成 `.mastra/output` API artifact 和 `.mastra/worker` 官方 Worker artifact。Playwright demo 需要额外安装浏览器 executable，不属于默认测试门禁。

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [Adding an Application](./docs/adding-application.md)
- [Permissions](./docs/permissions.md)
- [Workspace and durability](./docs/workspace-and-durability.md)
- [Production runbook](./docs/production-runbook.md)

## Breaking change

本次切换采用 fresh schema，不做 dual-write/backfill/legacy decoder。上线前必须先盘点数据并备份；发现有效旧数据时停止 reset，重新制定迁移方案。
