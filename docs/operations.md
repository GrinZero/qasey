# Production operations

This runbook covers the portable operational contract for a Qasey production
deployment. Replace example thresholds and escalation targets with approved
values before go-live. Do not put prompts, connector configuration, URLs,
tokens, or error bodies in metric labels.

## Service objectives

The initial recommended objectives are 99.9% monthly API availability, 99% of
accepted interactive requests beginning processing within 30 seconds, and all
non-suspended workflow runs reaching a terminal or failure-inbox state within
the configured heartbeat timeout plus two reconciler intervals. These are
starting targets, not evidence that a deployment has achieved them.

Scrape authenticated `GET /internal/metrics` with a principal holding
`platform.metrics.read`. `/healthz` only proves the process is alive; `/readyz`
removes a process from traffic when a required dependency fails or shutdown is
draining. Name the Prometheus scrape jobs `qasey-api` and `qasey-worker`; the
included per-target `up` alert relies on those exact job labels. If the platform
rewrites them, adapt the selector and validate the rule tests before promotion.
Install and tune `deploy/observability/prometheus-rules.yml`.

Each orchestration Worker has a separate private probe listener (default port
`8081`). Probe `/healthz` and `/readyz`; scrape `/metrics` with
`Authorization: Bearer <QASEY_WORKER_METRICS_TOKEN>`. The listener reports the
supervised Worker process and a fresh child-owned application heartbeat. The
heartbeat freshness bound is `QASEY_WORKER_HEARTBEAT_TIMEOUT_MS` (default
`15000`); the listener must be reachable only from the
cluster health controller and monitoring identity.

Every production deployment must set one shared `QASEY_DEPLOYMENT_ID`; every
process must set a unique `QASEY_INSTANCE_ID` and set `DD_VERSION` to the
promoted immutable image digest or equivalent release identifier. Tenant and run labels are identifiers only and allow an operator to
locate the corresponding audited record without exporting its content.

## Tenant operator control plane

The authenticated Admin BFF exposes tenant-scoped operator endpoints. They are
not service-to-service APIs: use a browser session with the named platform
permission, preserve the same-origin check on mutations, and never put a
credential in a query string or audit annotation.

| Operation | Endpoint | Permission |
| --- | --- | --- |
| List members / change status | `GET /admin/api/organization/members`, `PATCH /admin/api/organization/members/:userId` | `platform.members.read` / `platform.members.manage` |
| List / create / revoke invitations | `GET|POST /admin/api/organization/invitations`, `DELETE /admin/api/organization/invitations/:invitationId` | `platform.members.read` / `platform.members.manage` |
| List / create / update / rotate / revoke encrypted connections | `/admin/api/connections` and `/admin/api/connections/:connectionId` | `platform.connections.read` / `platform.connections.manage` |
| List / redrive / close workflow failures | `/admin/api/failures` and `/admin/api/failures/:failureId/{redrive,close}` | `platform.failures.read` / `platform.failures.manage` |

Every connection, failure, member, and invitation lookup derives the tenant
from the authenticated principal. Mutations use a numeric `revision` in the
JSON body and reject stale writers. Connection responses and audit records
contain metadata and credential fingerprints only; decrypted values are never
returned. A connection `rotate` operation re-encrypts the existing secret under
the active credential key, while updating `credentials` replaces the provider
secret.

Suspending or removing a member immediately invalidates browser sessions and
causes API-token authentication to recheck active membership on every use. The
same operation also revokes tokens created by that member and removes tenant
role bindings. Operators cannot deactivate their own current administrator
identity through this endpoint. Invitation acceptance is exact-email and
transactional; ambiguous invitations fail closed.

A failure redrive is accepted only for the current tenant, a failed source run,
and the expected failure revision. Reconcile any receipt in an unknown external
side-effect state with the provider before redriving. Closing an item records an
audited operator decision but does not rewrite the source run.

## Metrics or process missing

1. Check the workload and scraper authentication independently.
   `QaseyScrapeTargetDown` covers configured `qasey-api`/`qasey-worker` targets;
   in distributed mode, `QaseyWorkerMetricsMissing` uses
   `qasey_deployment_mode_info` to cover disappearance of the complete Worker
   role without creating a false alert for standalone deployments.
2. Query `/healthz`, then `/readyz`; never restore traffic based on liveness.
3. Compare the running digest with `qasey_build_info` and the release evidence.
4. If the process restarted, inspect the failure inbox before replaying work.

## Dependency unavailable

Use the `dependency` label to identify PostgreSQL, Redis, object storage,
Sandbox, or another owned store. Check provider health and connection capacity,
then compare failures across instances. Do not log connection strings. A failed
readiness dependency is not bypassed during an incident; restore it or remove
the affected replica from service.

## Worker unavailable

If Worker metrics disappear, first distinguish scrape discovery loss from an
actual workload loss. If `qasey_worker_process_up` is zero, treat the pod as
failed and inspect the supervisor's child exit status before allowing the
workload controller to replace it. If `qasey_worker_ready` remains zero, verify
PostgreSQL, Redis,
remote step execution, the immutable image version, Worker authentication, and
whether the child application heartbeat is still fresh.
Do not route orchestration work to the instance until `/readyz` recovers.

## HTTP SLO burn or latency

Use the bounded `application`, `route`, `method`, `status_class`, and release
labels on `qasey_http_requests_total` and
`qasey_http_request_duration_seconds`. The fast-burn alert indicates an acute
5xx increase; the slow-burn alert indicates sustained error-budget
consumption. Compare replicas and the promoted digest, then remove an unready
or regressed release from traffic. The included p95 threshold is deliberately
conservative because Agent execution routes may be long-running; tune it per
route only after a production-like load test. Do not add raw URLs, organization
names, subjects, prompts, or error text as labels.

## Traffic governance

HTTP 429 is an intentional admission decision. Use its `Retry-After` value and
the bounded `policy`, `scope`, and `reason` metric labels to distinguish a
fixed-window budget from expensive-request concurrency saturation. Do not
blindly retry an Agent, workflow, or Sandbox mutation: wait for the indicated
window and preserve its idempotency key. A
`qasey_traffic_store_error_total{operation="admit"}` increase accompanies
fail-closed HTTP 503 responses and normally indicates Redis loss in a
distributed deployment. A release failure leaves a TTL-bounded lease and does
not rewrite a successfully completed operation into 503, avoiding a duplicate
side effect. Restore the store and let the lease expire; do not delete broad
Redis prefixes during an incident.

Application quotas are not a network firewall. The ingress proxy must also
enforce connection, header, body, and trusted-client-IP limits before Node.js,
and production egress policy must deny link-local, loopback, RFC1918/private,
and metadata-service destinations. Tenant-managed Jira/MCP endpoints pass an
application-level public-HTTPS/DNS check and disable redirects, but DNS
rebinding protection still belongs at the resolver and network boundary.

## Sandbox capacity

`qasey_sandbox_unavailable_replicas` must be zero. Compare active, available,
and maximum session gauges. Drain a failing replica before replacement and do
not raise capacity by weakening isolation. If all slots are valid but occupied,
scale the Sandbox pool and its database-backed lease capacity together.

## Slack ingress overload

The queue is bounded and rejects the newest delivery before admission. Identify
the tenant and partition, check Worker health and downstream model latency, and
scale consumers before increasing the bound. The current upstream Slack adapter
returns HTTP 200 before asynchronous admission; therefore the internal retryable
outcome does not yet guarantee Slack will redeliver an event. Until the raw-event
durable ingress is installed, treat any overload increment as a possible lost
delivery and reconcile against Slack audit/event history.

## Stale workflow or failure inbox

Locate the tenant/run in the persisted failure inbox. Confirm the source run is
failed and inspect its redacted audit trail. Use the revision-protected operator
redrive action once; never start a second run manually in parallel. An unknown
external side-effect receipt requires an operator to reconcile the provider
before closing or retrying it.

## Model cost

Set both `QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN` and
`QASEY_MODEL_OUTPUT_COST_MICROUSD_PER_TOKEN` from the deployment's provider
contract. One micro-USD per token equals USD 1 per million tokens. Update rates
when the model or provider contract changes. The included USD 100/hour alert is
an example and must be replaced by an approved tenant budget.

## Incident evidence

Record the instance, release digest, tenant/run identifiers, UTC start/end,
alerts, mitigations, and recovery checks. Keep secrets and customer content out
of tickets. A production-readiness claim requires an exercised alert path and
on-call owner; repository configuration alone is not sufficient evidence.
