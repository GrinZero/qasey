# Shared Mastra Runtime Architecture

## Runtime boundary

`src/mastra/index.ts` is the official Mastra entry point and contains the only production `new Mastra(...)`. `src/runtime/create-runtime.ts` only flattens and validates Application bundles into Mastra configuration; the bundles are ownership/DI metadata, not execution primitives.

Application bundles catalog both code-registered and file-discovered Agent IDs so authorization is complete before the server starts. Only code-registered Agents enter `MastraConfig.agents`; `mastra dev` and `mastra build` own the single runtime registration of file-discovered Agents.

```mermaid
flowchart TD
  Client["Admin UI / API / Slack / Jira"] --> Body["streaming request-body ceiling"]
  Body --> Auth["OAuth identity / signed-ingress route classification"]
  Auth --> Permission["deny-by-default permission middleware"]
  Permission --> Traffic["tenant / subject quotas · expensive concurrency"]
  Traffic --> Browser["browser same-origin mutation boundary"]
  Browser --> Native["Mastra native handlers"]
  Native --> Qasey["Qasey Application"]
  Native --> Future["Additional Applications"]
  Qasey --> Shared["Context · Store · Observability · MCP · Workspace"]
  Future --> Shared
  Qasey --> Domain["Owner-scoped Run / Event / Artifact repositories"]
  Native -. "distributed mode" .-> PubSub["Redis Streams PubSub"]
  PubSub --> Worker["Official Mastra orchestration Worker"]
  Worker -->|"official step execution HTTP"| Native
```

Registry keys and primitive canonical IDs are identical and prefixed with `${applicationId}-`. Every registered primitive and custom route has permission metadata. Unknown server routes are rejected. Internal primitives, such as the intent router, are held by application services and are not registered. A lifecycle-dependent internal workflow may be registered with a service-only audience.

## Trust and ownership

OAuth and service identities are converted to a server-owned principal. The middleware derives application, tenant, roles, memory resource/thread, request ID, and ingress source. Request body/header ownership values are not copied.

- Private resource: `application:tenant:user`
- Shared resource: `application:tenant:conversation`
- Thread: `application:tenant:kind:external-thread`
- Domain owner: `{ applicationId, tenantId }`
- External write key: `application:tenant:workflow:run:effect`

Runs, events, artifacts, channel delivery IDs, permissions, and OAuth credentials all include owner information in their storage key or primary key.

Distributed traffic governance uses atomic Redis Lua admission across the
tenant and subject layers plus TTL-bounded expensive-request leases. Redis keys
contain SHA-256 identity digests, not tenant or subject text. Standalone keeps
the same contract in process. Browser mutations additionally require the exact
configured public origin after authentication; public OAuth mutations retain
their route-local same-origin checks.

## Native capabilities

- Agent/Workflow execution uses Mastra server endpoints.
- Standalone production runs orchestration in the API process and needs neither
  Redis nor a Worker. Distributed production uses Mastra's official fully split
  orchestration Worker: the API sets `MASTRA_WORKERS=false`, the worker sets
  `MASTRA_WORKERS=orchestration`, and `MASTRA_STEP_EXECUTION_URL` delegates step
  execution back to the API.
- API and Worker artifacts are produced only by `mastra build` and `mastra worker build`. There is no Qasey worker entry point, queue protocol, poll loop, lease, or direct workflow executor.
- Slack uses Mastra Channels with signed webhook or Socket Mode, native streaming, approvals, attachments, dedupe, and per-thread queueing.
- Long-running state uses Workflow snapshots and Redis Streams event delivery. The removed generic queue worker is not a durability layer.
- Mastra domains use `MastraCompositeStore`; Qasey domain data remains in explicit repositories.
- Workspace is dynamic per application/tenant/task/execution/role. Production exposes no execution sandbox unless a remote provider is configured.
- Non-OAuth MCP service connections are shared. OAuth connections use a bounded subject pool and separate encrypted credential namespace.

## Process lifecycle

The composition root owns stores, repositories, MCP clients, sandbox cache,
permission store, and audit store. `closeRuntime()` closes them in reverse
ownership order. The standalone profile has one API deployment. The distributed
profile adds an official orchestration Worker built from the same source entry
point; only the API exposes public HTTP, while the Worker pulls Redis events and
calls the API over a private deployment network. There is no separate Slack
receiver or generic Qasey worker.

PostgreSQL is the only mandatory state service. Supabase is supported as a
standard managed PostgreSQL endpoint and has no privileged SDK path. Redis,
Slack, Jira, GitHub, MCP servers, remote Sandbox capacity, and Datadog are
enabled only when their deployment-owned configuration is present.

## Intentional product-layer extensions

Two extensions are explicit architecture boundaries, not alternate Mastra runtimes:

- Google OAuth/OIDC, single-tenant password credentials, opaque browser sessions, service Bearer tokens, tenant permissions, and audit decisions are platform-owned. The runtime does not configure Mastra Enterprise auth; the same deny-by-default middleware authenticates and authorizes Admin UI, API, Worker, and channel requests before native handlers execute.
- `/admin` is the multi-Application product console needed for Qasey and future Agents. Mastra Studio remains the developer/debugging surface; Admin UI uses the registered Application catalog and business-safe routes.

## Observability

Mastra Observability and the storage exporter are authoritative. Datadog receives application, tenant, user, request, thread, task, channel, agent/workflow/model fields when available. Credentials, email, prompts, bodies, attachments, and long content are redacted by default. Authorization decisions and permission mutations are written to the audit log.
