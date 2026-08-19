# Native Shared Mastra Runtime 重构计划

## Status

- 状态：Ready for breaking implementation；Phase 0 native capability spikes 通过后开始重构
- 目标：将当前 Qasey-specific runtime 重构为单一 Shared Mastra Runtime，原生承载多个独立 Agent Applications
- 前提：线上没有需要保留的有效业务数据；允许 API、ID、DB schema、Memory、OAuth namespace 和 queue contract 发生 Breaking Change
- 策略：不做 dual-write、backfill、shadow-read、legacy decoder 或 mixed-version worker；备份后直接建立新模型
- 版本：第一轮使用当前锁定的 `@mastra/core@1.59.0` 等版本；新增官方 durable engine integration 必须单独验证，不为了重构本身升级 Mastra

## Architecture

```text
                       Application / Channels
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                  │
          Admin UI / Web       API          Slack / Channels
              │                 │                  │
              └──────── Existing OAuth / Trusted Ingress ────────┐
                                                                  │
                       Permission Middleware                      │
                                │                                 │
                       Mastra Server / Runtime ◀──────────────────┘
                                │
                 Native RequestContext + OpenAPI
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
           ▼                    ▼                    ▼
       Agent App A          Agent App B          Agent App C
        (Qasey)               (HR)               (Revenue)
           │                    │                    │
      Agent / Tools /      Agent / Tools /      Agent / Tools /
        Workflows            Workflows            Workflows
           │
           └──────────── Shared Native Capabilities ──────────────┐
                                                                 │
       ┌────────────┬──────────────┬─────────────┬────────────────┤
       ▼            ▼              ▼             ▼                ▼
     Models     Composite Store  Observability   MCP        Workspace/Sandbox
       │
       └──────────── OAuth / Secrets / Domain Repositories ──────┘
```

## Non-negotiable Principles

1. 生产代码只有一个 `new Mastra(...)` composition root。
2. Mastra registry 是 service catalog：只有需要通过 Mastra Server、Client 或 Admin UI 服务化的 primitive 才注册。
3. 纯内部 Agent/Workflow 不进入顶层 registry；Application service 直接持有实例。若当前版本的 lifecycle/storage 要求注册，才允许注册并由服务端 permission middleware 禁止外部访问。
4. Application 只是 composition-time ownership/DI bundle，不是新的运行时 primitive。
5. API、Admin UI 和 Channels 直接使用 Mastra 原生 Agent/Workflow handlers；不增加通用 dispatcher。
6. 使用原生 RequestContext、requestContextSchema、Memory resource/thread、Workspace、Workflow snapshots、Composite Store、MCPClient 和 Observability。
7. OAuth + 自有 permission middleware 只做认证、授权和可信 context 注入，不代理 generate/stream/run/resume。
8. Qasey Run/Artifact 等 Domain Data 不伪装成 Mastra Storage domain；通过 owner-scoped repository 管理。
9. 不为不存在的线上数据建设兼容迁移框架；部署前做一次备份和数据量确认，然后直接 reset/recreate。
10. 强安全、独立故障域或独立扩缩容需求通过拆 Runtime/Deployment 解决，不靠 TypeScript interface 模拟沙箱。

## What Is Removed From the Previous Plan

- 删除 expand → dual-write → backfill → shadow-read → enforce 流程。
- 删除 Memory `cloneThread` migration、OAuth copy-on-read 和 legacy namespace rollback。
- 删除 queue v1/v2 mixed rollout、legacy decoder 和 generic checkpoint codec 设计。
- 删除通用 Application `execute/decode/checkpoint/notification` 协议。
- 删除自建 WorkspaceProvider、SandboxProvider、Storage facade 和 MCP connection manager。
- 不保留为了兼容旧 endpoint 而重复注册的 registry alias。
- 生产管理面不依赖 Mastra Studio；使用自有 Admin UI，Studio 仅限本地或受控内网。

## Target Structure

```text
src/
  mastra/
    index.ts                      # 唯一 composition root

  runtime/
    create-runtime.ts
    registry-validator.ts
    application.ts

  platform/
    auth/
      oauth-principal.ts
      authorization-middleware.ts
      permission-store.ts
      audit-log.ts
    context/
      schema.ts
      identity-resolver.ts
      conversation-scope.ts
    storage/
      create-composite-store.ts
      lifecycle.ts
    observability/
    mcp/
      create-clients.ts
      credential-forwarding.ts
    workspace/
      create-workspace.ts
      sandbox-lifecycle.ts

  agent-apps/
    qasey/
      application.ts
      service.ts
      agents/
      tools/
      workflows/
      memory/
      evals/

apps/
  admin-ui/
  api/
  worker/                         # 仅在选定官方 durable engine 后保留对应 worker

packages/
  contracts/
  domain/
  adapters/
  e2e/
```

## Phase 0 — Native Capability Spikes

本阶段只做最小可执行验证，不建设抽象。

### 0.1 Registry and internal primitives

- 将两个 test Applications flatten 到一个 Mastra registry。
- 验证 registry key、Agent canonical ID、Workflow canonical ID 重复时的实际行为。
- 验证未注册的 internal Agent/Workflow 能否保持 model、storage、observability 和 workflow snapshot 能力。
- 如果未注册 primitive 缺失必要 Mastra lifecycle，记录精确缺口；fallback 是注册后由 permission middleware deny，而不是自建执行层。

### 0.2 RequestContext

- 在 Agent、Tool、Workflow 和 Step 上声明同一份 `requestContextSchema`。
- 验证 OAuth/API、Channel 和 background worker 三种入口都能注入同一种原生 RequestContext。
- 验证可信 tenant/application/roles/resource/thread 不能被 body/header 覆盖。

### 0.3 Workflow durability

- 使用 PostgreSQL storage 验证 workflow suspend、进程退出、按相同 run ID resume。
- 验证 snapshot 中只允许 JSON-safe state；大型对象只保存 ID/URI。
- 对当前 E2E/Slack 可靠性要求做一次故障测试：worker kill、网络错误、重复 delivery、恢复、幂等 external write。
- 若原生 snapshots 足够，删除自建 queue/checkpoint；若要求自动跨 worker retry/recovery，优先选择 Mastra 官方 Inngest integration。Temporal integration 当前仍需单独评估成熟度，不作为默认方案。

### 0.4 Native Channels

- 用 Mastra Channels 接入 Slack，验证签名、mention/DM、attachments、approval、streaming 和 thread mapping。
- 使用 `resolveResourceId`/`resolveThreadId` 统一 Memory ownership。
- 验证 Signal API 的 queue/debounce/batch/skip；普通会话默认使用 per-thread queue。
- Channels 不负责的 durability 交给 Workflow/durable engine，不再维护第二套通用 channel queue。

### 0.5 Workspace and MCP

- 验证 Agent dynamic Workspace 按 RequestContext 返回 filesystem/sandbox。
- 验证 Code Mode 使用 execution context sandbox，而不是 `process.cwd()`。
- 开发环境使用 LocalSandbox；生产执行不可信代码时验证一个官方支持的 remote sandbox provider。
- 验证 MCP shared service client、request-scoped custom fetch 和 subject-bound OAuth client 三种模式。

验收：每个结论都有 executable test 或 spike；未通过的原生能力才允许增加薄 adapter，并记录原生缺口。

## Phase 1 — Composition Root and Native Platform

### Application bundle

```ts
interface PrimitiveAccessPolicy {
  permission: string;
  audiences: readonly ("admin-ui" | "api" | "service" | "channel")[];
}

interface AgentApplicationBundle {
  id: string;
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow>;
  scorers?: Record<string, Scorer>;
  access: {
    agents: Record<string, PrimitiveAccessPolicy>;
    workflows: Record<string, PrimitiveAccessPolicy>;
    scorers?: Record<string, PrimitiveAccessPolicy>;
    channels?: Record<string, PrimitiveAccessPolicy>;
  };
  routes?: readonly OwnedApiRoute[];
}
```

- Bundle 中只包含需要注册到 Mastra Server 的 public/service primitives。
- Internal primitives 留在 Application factory closure 内，由 app-owned service/Workflow 直接引用。
- Composition root 合并 bundles，校验 application ID、registry key 和 canonical ID 唯一，再创建唯一 Mastra instance。
- 新 ID 采用 `${applicationId}-${primitiveName}` 命名；registry key 与 canonical ID 保持一致。旧 ID 不做 alias。

### Native platform

- 使用 `MastraCompositeStore` 配置 memory、workflows、scores、observability 和 agents domains。
- Qasey Domain Repository、Artifact Storage 和 OAuth credential storage 保持独立。
- 所有长生命周期资源由一个 process-scoped lifecycle container 管理并支持 `close()`。
- API、Channel、durable worker 按 process mode 只初始化自身需要的能力。

验收：生产代码只有一个 Mastra instance；导入 Application 不会启动 DB、MCP、Workspace 或其他 infrastructure；两个 fixture Applications 可同时运行。

## Phase 2 — OAuth, Permission Middleware and Admin UI

### Authentication and authorization

- Google/组织 OAuth、浏览器 session 与 service token 由平台层自行实现，不配置 Mastra Enterprise auth；Mastra 只承载原生 Agent/Workflow handlers。
- OAuth principal 映射为可信 subject、tenant、roles 和 service identity。
- Permission middleware 在 Mastra handlers 注册之前执行，只做：
  1. 解析 `{ applicationId, resourceType, resourceId, action }`。
  2. 调用 `PermissionService.authorize(...)`。
  3. 写入原生 RequestContext。
  4. allow 后继续进入原生 handler。
- 权限默认 deny。初期使用简单 Postgres role、permission、subject/group binding 和 audit tables；未来可以替换为公司 IAM/OpenFGA/OPA。
- 所有注册 primitive 和 custom route 都必须有 permission metadata；缺失时启动失败。

### Admin UI

- 新建 `apps/admin-ui`，默认与 Mastra API 同源。
- 功能范围：OAuth 登录、Application/Agent/Workflow catalog、原生 generate/stream/run/resume、Run/Trace 查询、role/permission/binding 管理和 audit 查看。
- Mastra 全局/list endpoints 只授予 platform admin/service identity。普通用户的可见 catalog 由 Admin UI BFF 根据 composition metadata + PermissionService 过滤，避免修改 Mastra 原生列表 handler。
- Admin UI 的具体 execute/stream/run/resume 调用仍直达 Mastra 原生 endpoints；BFF 只处理 session、catalog/聚合、审计和必要的无缓冲 stream 转发。
- `platform.admin-ui.access` 与 `platform.permissions.manage` 分离。
- Bootstrap admin 只能来自部署配置或可信 OAuth group；提供受审计的 break-glass 恢复流程。
- 生产 Studio 默认关闭或仅限受控内网。

### Route coverage

- 从当前版本 OpenAPI/built-in route manifest 生成 permission classification fixture。
- 覆盖 Agent、Workflow、Tool、Scorer、Channel webhook、stored primitives 和 global/event routes。
- 未分类 route 默认拒绝。无明确 resource ID 的全局/list route 要求独立 platform permission；具体 primitive endpoint 按 resource/action 授权并返回统一的 403/404 策略。

验收：匿名、越权、伪造 tenant/role、伪造 Studio header 均被拒绝；OAuth callback/session/logout 和原生 streaming 行为正常；Admin UI 隐藏按钮不是授权控制。

## Phase 3 — Native Identity, Memory and Fresh Ownership Model

### RequestContext

```ts
interface PlatformRequestContextValues {
  requestId: string;
  applicationId: string;
  channel: "api" | "web" | "slack" | "jira" | "worker";
  ingressSource: string;
  identity: {
    userId: string;
    tenantId: string;
    roles: string[];
  };
  sessionId: string;
  taskId?: string;
  executionId?: string;
  [MASTRA_RESOURCE_ID_KEY]: string;
  [MASTRA_THREAD_ID_KEY]: string;
}
```

- Agent、Tool、Workflow 和 Step 使用原生 `requestContextSchema`。
- API 使用 OAuth principal；Slack/Jira 使用验证后的 installation；worker 使用受信 service identity。
- body 中的 tenant/application/roles/resource/thread 一律忽略或拒绝。

### Memory ownership

- Private conversation：`resourceId = application:tenant:user`。
- Shared conversation：`resourceId = application:tenant:conversation`。
- `threadId = application:tenant:conversation-kind:external-thread-id`。
- Native Channels 与 API 使用同一个 `conversationScope()` 函数。
- 不迁移旧 Memory；切换时直接启用新 namespace，旧数据允许丢弃。

### Domain ownership

```ts
interface OwnerScope {
  applicationId: string;
  tenantId: string;
}
```

- Run、Event、Artifact、Queue/Durable metadata 从第一天使用 NOT NULL owner columns。
- Repository API 只提供 `get(ownerScope, id)`、`list(ownerScope, ...)`、`update(ownerScope, id, ...)`。
- Artifact path 使用 `application/tenant/run`，并保留 realpath containment check。
- 部署前确认线上数据量并做一次备份；随后直接创建新 schema。没有 legacy read/backfill 路径。

验收：跨 tenant/application 的 Memory、Run、Event、Artifact 查询和变更全部失败；不存在未 scoped repository API。

## Phase 4 — Qasey as a Native Agent Application

- 将 Qasey Agent、Tools、Workflows、Memory、Scorers 和业务 orchestration 移入 `src/agent-apps/qasey`。
- Qasey main Agent 和需要由 API/Admin UI 调用的 Workflow 注册到 Mastra。
- Intent Router、MeterSphere write workflow 等只由 Qasey 内部使用的 primitives 默认不注册；由 main Agent/service 直接引用。
- API/Web/Admin UI 使用 Mastra native Agent generate/stream 和 Workflow run/resume endpoints。
- 删除 `/v1/qasey` custom execution facade；只有确实没有原生等价能力的领域 route 才保留 `registerApiRoute`。
- Deterministic external writes 使用 Workflow/Tool schema、approval 和 idempotency，而不是把所有逻辑塞进 Agent prompt。
- Tool 和 Workflow 使用 dynamic arguments，根据 RequestContext 返回当前 Application/tenant/role 获准的 capabilities。
- 新增第二个 test Application，使用不同 Agent、Workflow、Memory scope、Workspace 和 MCP/tool set，证明没有 Qasey-specific contract 泄漏。

验收：Qasey 可完全通过原生 Agent/Workflow API 运行；internal primitives 没有公开 endpoint；第二 Application 不 import Qasey internals。

## Phase 5 — Native Channels and Durable Execution

- Slack ingress 迁移到 Mastra Channels；使用原生 webhook、streaming、thread mapping、attachments 和 approvals。
- 普通消息并发使用 Signal API per-thread queue。
- 长流程由 Mastra Workflow 管理 state、retry、suspend/resume 和 snapshot。
- 对必须自动跨 worker crash 恢复的流程，采用 Phase 0 选定的官方 durable engine integration；不建设 application-neutral 自有 queue framework。
- External write 使用稳定 idempotency key，格式为 `application:tenant:workflow:run:effect`。
- 完成故障注入测试后删除 legacy Slack receiver queue、Qasey checkpoint、outbox compatibility 和 v1/v2 envelope 代码。

验收：Slack message → Channel → Agent/Workflow 全链路原生运行；进程重启、重复 delivery、approval resume 和 external write 幂等满足约定 SLO。

## Phase 6 — Native Workspace, Sandbox and MCP

### Workspace

- Agent 使用原生 dynamic `workspace({ requestContext })`。
- Workspace scope 为 `application / tenant / task / execution / role`。
- `sandboxCacheKey` 使用稳定 task/execution key；配置容量、idle TTL 和 shutdown。
- 开发环境可以使用 LocalFilesystem/LocalSandbox。
- 生产 Code Mode 或不可信代码使用 remote sandbox；没有 sandbox 时不暴露 command/code execution tools。
- E2E Author/Verifier clean workspace 保持领域流程，但底层使用 Workspace/Sandbox provider。

### MCP

- Service credential server：共享 MCPClient。
- Request bearer/cookie server：共享 MCPClient，通过原生 custom `fetch(url, init, requestContext)` 转发。
- OAuth/session-bound server：按 credential subject 使用 bounded client；只有这种类型需要 capacity、TTL、LRU 和 disconnect。
- Agent tools 使用 dynamic configuration 按 RequestContext 控制可见性。
- `tools/list` 需要 subject auth 时使用 subject client；不得假设首次连接一定有 RequestContext。
- 不创建第二套通用 connection manager。

验收：不同 tenant/application 的 filesystem、sandbox、tools 和 credentials 不可互访；Code Mode 无法访问 runtime repository cwd。

## Phase 7 — Observability, Cleanup and Documentation

- RequestContext 和 trace 统一包含 application、agent、workflow、tenant、user、request、thread、task、channel、model 和 environment。
- 使用 Mastra Observability/Storage exporter 和现有 Datadog bridge；不再维护 Qasey-only trace schema。
- 默认清理 email、token、OAuth payload、附件正文、完整 prompt 和 secrets。
- Permission change、denied request、credential selection、workflow resume 和 external write 进入结构化 audit/trace。
- 删除 legacy runtime facade、custom dispatcher、旧 queue compatibility、旧 Memory/OAuth migration code、重复 storage/workspace/MCP abstractions。
- 更新 `ARCHITECTURE.md`、Adding an Application、permissions、workspace、durability 和 deployment runbook。

验收：代码搜索确认不存在第二个 Mastra instance、通用 Application execution protocol 或 legacy compatibility path；可按 application/tenant/request 查询 trace 和 audit。

## Breaking Changes

本计划主动接受以下 Breaking Changes：

- Agent/Workflow registry key 和 canonical ID 统一为新命名规则，旧 endpoint 不保留 alias。
- `/v1/qasey` 可删除，客户端迁移到 Mastra native Agent/Workflow endpoints。
- 旧 Memory thread/resource 不迁移。
- 旧 OAuth namespace 不迁移，用户可重新登录/授权。
- Run/Event/Artifact 使用全新 owner-required schema；旧数据在备份后允许丢弃。
- 旧 Slack queue/checkpoint/outbox/envelope contract 在原生 Channels/durable workflow 验证后删除。
- 生产 Mastra Studio 默认不开放，管理操作迁移到 Admin UI。
- 旧环境变量和内部 imports 可清理；最终列表在实施 PR 中明确记录。

## Test Plan

### Composition

- 生产代码只有一个 `new Mastra(...)`。
- 两个 Applications 可同时注册和运行。
- application/key/canonical ID 冲突启动失败。
- Internal primitive 没有公开 endpoint。
- 缺少 permission metadata 的 registered primitive 启动失败。

### Auth and Admin UI

- OAuth session、bearer、service principal 和 trusted ingress 正确映射 identity。
- 匿名、跨 tenant、跨 application、伪造 roles/Studio header 请求失败。
- 所有 built-in routes 有 permission classification。
- Admin UI 登录、CSRF、secure cookie、filtered catalog、permission mutation、audit 和 SSE streaming 通过。

### Native Context and Storage

- RequestContext schema 覆盖 Agent、Tool、Workflow、Step 和 trace。
- private/shared Memory owner/thread 行为正确。
- 所有 Domain repository operations 强制 OwnerScope。
- Workflow suspend → process exit → resume 通过。
- Snapshot 只包含 JSON-safe、小尺寸数据。

### Channels and durability

- Slack mention/DM/thread/attachment/approval/streaming 通过。
- 同 thread 并发消息按选定 Signal mode 工作。
- worker kill、retry、duplicate delivery、resume 和 external write 幂等通过。

### Workspace and MCP

- application/tenant/task Workspace 不重叠。
- Code Mode 不访问 runtime cwd。
- Remote sandbox failure 时执行工具不可见或 fail closed。
- MCP service/request-forwarded/subject-bound 三种模式通过。
- Subject client eviction/shutdown 不泄漏连接。

### Final verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

Root scripts 必须包含 Admin UI build/test。内部 Nexus 的 `@moego/aws-secret-env` 404 和缺失 Playwright executable 仍需单独报告，不能把环境失败伪装成代码通过。

## Rollout

1. 在 staging 使用全新 DB/schema、Memory namespace、OAuth namespace 和 Slack test app 部署。
2. 通过原生 API、Admin UI、Channels、Workflow resume、Workspace/MCP 和第二 Application tests。
3. 上线前记录生产数据量；创建一次数据库和 credential namespace 备份。
4. 进入短维护窗口，停止旧 API/Slack/worker。
5. 部署新版本并创建全新 schema；不启动 legacy migration。
6. 执行 smoke tests：OAuth、Admin UI、Agent stream、Workflow run/resume、Slack、Artifact、MCP、Workspace。
7. 失败时回滚代码并恢复备份；成功后在约定观察窗口结束时删除旧 schema/artifacts。

## Remaining Risks

| 风险 | 控制方式 |
|---|---|
| “线上无数据”判断错误 | 上线前自动 inventory + 人工确认 + 一次备份；发现有效数据立即停止 reset |
| 未注册 internal Workflow 缺少 lifecycle/storage | Phase 0 spike；必要时注册并由 permission middleware deny |
| Native Channels 不满足跨进程 durability | 将 durability 放入原生 Workflow + 官方 Inngest integration，不回到通用自建 queue |
| 官方 durable integration 增加外部基础设施 | 用 SLO 决定是否启用；没有跨 worker 自动恢复要求时只使用原生 snapshots |
| Remote sandbox 成本或可用性 | dev 使用 LocalSandbox；prod 设置 quota/timeout/fallback，失败时关闭 code execution |
| 同 Runtime 资源竞争和故障传播 | per-app concurrency/timeout/metrics；需要硬边界时拆 deployment |
| Permission route classification 漏洞 | 从当前 OpenAPI/route manifest 生成测试；未知 route 默认拒绝 |
| 未来重新引入第二套 runtime 抽象 | dependency/architecture tests，禁止 dispatcher 和平行 Context/Storage/Workspace/MCP APIs |

## Definition of Done

- [ ] 唯一 Mastra Runtime 原生注册多个 Applications
- [ ] Application 只是 composition bundle，内部 primitive 默认不注册
- [ ] API/Admin UI/Channels 使用 Mastra native handlers
- [ ] OAuth + server-side permission middleware 覆盖全部注册 surfaces
- [ ] Typed native RequestContext 贯穿 Agent、Tool、Workflow、Step、MCP、Workspace 和 trace
- [ ] Memory 使用明确的 private/shared resource/thread ownership
- [ ] Domain schema 从第一天强制 application/tenant OwnerScope
- [ ] Workflow snapshots 和选定的官方 durability 方案通过故障测试
- [ ] Slack 使用 Mastra Channels，legacy queue compatibility 已删除
- [ ] Workspace/Code Mode 使用原生 scoped Workspace 和生产 sandbox
- [ ] MCP 使用原生 client/context forwarding，只有 OAuth session 使用 subject cache
- [ ] Mastra Composite Store 管理原生 storage domains
- [ ] Admin UI 完成 OAuth、Agent/Workflow/Run 和 permission 管理
- [ ] 第二个 test Application 证明无 Qasey-specific dependency
- [ ] Legacy migration、dispatcher、parallel platform abstractions 已删除
- [ ] `pnpm typecheck`、`pnpm test`、`pnpm build` 达到约定基线
- [ ] `ARCHITECTURE.md` 和 production runbook 完成
