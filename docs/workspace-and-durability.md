# Workspace, MCP, and durability

## Workspace

The native Workspace filesystem is rooted at:

`application / tenant / task / execution / role`

Segments are sanitized and containment is checked. Development can use a bounded LocalSandbox cache. Production code execution fails closed unless `createScopedWorkspace` receives a remote sandbox provider. Runtime repository `process.cwd()` is never used as an execution workspace.

The E2E author/verifier clean-workspace discipline remains a Qasey domain workflow, while its paths and artifacts are owner scoped.

## MCP

- `none`/service bearer servers: one shared MCP client.
- Request-forwarded credentials: allowlisted custom fetch with RequestContext.
- OAuth/session servers: bounded subject client pool, TTL/LRU disconnect, namespace `application:tenant:subject:server`.

OAuth tools are unavailable when a trusted credential subject is absent. Dynamic tool selection applies Qasey intent/channel policy after discovery.

## Workflow durability

This deployment uses Mastra native workflow snapshots and the official fully split orchestration Worker. Redis Streams provides pull-mode event delivery; PostgreSQL is shared storage; the Worker delegates step execution to the API through Mastra's standard HTTP endpoint. There is no generic Qasey queue worker. Snapshot state must be bounded JSON-safe data; large output is persisted as artifact IDs/URIs. Deterministic writes use stable idempotency keys and persisted verification receipts.

Mastra Workers are currently beta: failed events retry without a DLQ, and an API crash during a running workflow step can still leave a run stuck. Durable Agents use official `recovery.durableAgents: "auto"`; ordinary Workflow handlers must remain idempotent and operations must monitor stuck runs. Do not recreate a generic application queue to mask these limitations.
