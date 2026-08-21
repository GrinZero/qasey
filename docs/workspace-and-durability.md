# Workspace, MCP, and durability

## Workspace

The Mastra runtime owns one global Workspace. Qasey inherits it instead of
using the static workspace that Mastra otherwise creates for a file-based
agent. Its filesystem and sandbox use Mastra's native request-context
resolvers, with the effective filesystem rooted at:

`application / tenant / session`

This is conversation isolation rather than unconditional per-user isolation:
private sessions receive their own scope, while trusted shared Slack/Jira
threads intentionally share one scope. Segments are sanitized and containment
is checked. Development can use a bounded LocalSandbox cache. Production code
execution fails closed unless `createScopedWorkspace` receives a remote
sandbox provider. Runtime repository `process.cwd()` is never used as an
execution workspace.

Qasey task Skills remain agent-level Skills discovered from the file-based
agent directory. Global reusable Skills remain on the global Workspace. Skills
are read-only definitions and do not require per-session filesystem isolation.

The E2E `WorkspaceManager` is a separate domain abstraction. It creates a
clean repository checkout per run and enforces allowed changed paths; it is not
the Mastra agent workspace shown in Studio.

The E2E author/verifier clean-workspace discipline remains a Qasey domain workflow, while its paths and artifacts are owner scoped.

## MCP

- `none`/service bearer servers: one shared MCP client.
- Request-forwarded credentials: allowlisted custom fetch with RequestContext.
- OAuth/session servers: bounded subject client pool, TTL/LRU disconnect, namespace `application:tenant:subject:server`.

OAuth tools are unavailable when a trusted credential subject is absent. Dynamic tool selection applies Qasey intent/channel policy after discovery.

## Workflow durability

This deployment uses Mastra native workflow snapshots and the official fully split orchestration Worker. Redis Streams provides pull-mode event delivery; PostgreSQL is shared storage; the Worker delegates step execution to the API through Mastra's standard HTTP endpoint. There is no generic Qasey queue worker. Snapshot state must be bounded JSON-safe data; large output is persisted as artifact IDs/URIs. Deterministic writes use stable idempotency keys and persisted verification receipts.

Mastra Workers are currently beta: failed events retry without a DLQ, and an API crash during a running workflow step can still leave a run stuck. Durable Agents use official `recovery.durableAgents: "auto"`; ordinary Workflow handlers must remain idempotent and operations must monitor stuck runs. Do not recreate a generic application queue to mask these limitations.
