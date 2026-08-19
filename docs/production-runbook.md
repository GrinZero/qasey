# Production runbook

## Before the maintenance window

1. Deploy staging with a new database/schema, OAuth namespace, artifact root, and Slack test app.
2. Run `pnpm check` and confirm `.mastra/output/index.mjs`, `.mastra/output/studio/index.html`, and `.mastra/worker/index.mjs` exist. Smoke OAuth, protected `/studio`, `/admin`, Agent generate/stream, Workflow start/suspend/resume, Run/Artifact access, Slack mention/DM/thread/attachment/approval, Jira, MCP, Workspace, and audit.
3. Inventory old run, queue, outbox, memory, OAuth, and artifact data. If any business data must survive, stop; this release intentionally has no backfill path.
4. Create a database and credential/artifact backup and record restore commands.

## Cutover

1. Enter the maintenance window and stop old API, Bolt receiver, and worker processes.
2. With auto-commit enabled, connect to `postgres` and run `deploy/postgres/001_create_databases.sql`; then connect to `moego_qasey` and run `deploy/postgres/002_init_moego_qasey.sql`. Both scripts fail immediately when run against the wrong database.
3. Provision the dedicated `qasey.mastra.worker.token` secret, shared PostgreSQL, and Redis Streams connection. Deploy the API with `MASTRA_WORKERS=false`, then the private orchestration Worker with `MASTRA_WORKERS=orchestration`, `MASTRA_STEP_EXECUTION_URL=http://moego-qasey-api/studio/api`, and `MASTRA_WORKER_AUTH_TOKEN`. Keep Studio behind Google OAuth/RBAC and leave Editor/MCP Preview disabled unless separately reviewed.
4. Update Slack Events and Interactivity URLs to `/studio/api/agents/qasey-main/channels/slack/webhook`.
5. Run the staging smoke list against production and verify owner-scoped audit/trace records.

## Health and diagnosis

- `/healthz`: process liveness.
- `/readyz`: runtime/storage readiness metadata.
- `/studio`: OAuth/RBAC-protected Mastra Studio; `GET /` is its public instance-discovery probe.
- `/admin/api/audit`: current tenant audit records.
- Mastra observability endpoints: platform-admin/service only.
- Worker: no HTTP endpoint by design; use process liveness, Redis consumer lag/pending entries, step callback errors, and workflow run age.

Never log raw OAuth payloads, Authorization/Cookie headers, attachments, or full prompts. Use request ID, application, tenant, thread, workflow run ID, and artifact URI for diagnosis.

## Rollback

Stop the orchestration Worker and API, restore the captured database/credential/artifact backup, deploy the previous matching API/Worker image pair and Slack URL, then smoke the previous ingress. Do not run mixed Worker/API versions.
