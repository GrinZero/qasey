# Production readiness program

Status: repository production baseline implemented; **not yet GA-approved**.

The checklist distinguishes code and repeatable repository gates from evidence
that can exist only in a production-like environment. A checked item means the
implementation and its local/CI contract test are present. It does not imply
that a provider canary, failover drill, RPO/RTO review, or on-call exercise has
already happened.

This document defines the requirements, architecture decisions, implementation
sequence, and release gates for moving Qasey from a community self-hosted
preview to a production-supported service. It applies to the public repository
and uses only redacted fixtures and public dependencies.

## Supported profiles

- `standalone`: one API process with PostgreSQL. This profile is intended for a
  controlled single-tenant deployment and keeps remote code execution disabled
  unless a separately secured Sandbox is configured.
- `distributed`: multiple API and orchestration Worker replicas with PostgreSQL,
  Redis Streams, shared artifact storage, and an authenticated Sandbox pool.
- `multi-tenant`: an additional security profile layered on `distributed`.
  Tenant membership and every external connection are explicit; process-global
  service credentials are rejected.

Features that cannot meet the selected profile fail closed during startup. A
deployment does not gain a production capability merely by setting an endpoint
or feature flag.

## Requirements

### PR-1: authenticated execution plane

**User story:** As an operator, I need only the Qasey control plane to create a
Sandbox session so that a network-reachable Sandbox cannot become a remote code
execution entry point.

1. WHEN the control plane claims a Sandbox session THEN it SHALL attach a
   short-lived signed claim bound to the application, tenant, session,
   workspace, lease generation, request body, issuer, audience, and expiry.
2. WHEN a claim is missing, expired, replayed for different lease data, or has
   an invalid signature THEN the Sandbox SHALL reject it before changing state.
3. WHEN a production deployment configures a Sandbox endpoint THEN both the API
   and Sandbox SHALL require a dedicated control-plane signing key of at least
   32 random bytes and SHALL reject an insecure remote HTTP endpoint.
4. WHEN arbitrary repository commands execute THEN their environment SHALL NOT
   contain GitHub personal access tokens or Git authorization headers.
5. IF the Sandbox is in production THEN it SHALL reject `isolation=none` and
   SHALL require a tested process-isolation boundary. An external VM/container
   boundary MAY be added as defence in depth, but it does not disable the
   Sandbox's own isolation requirement.

### PR-2: deterministic distributed roles

**User story:** As an operator, I need API and Worker roles to have one
unambiguous execution contract so that scaling a deployment does not silently
change workflow ownership.

1. WHEN `api` starts in distributed mode THEN it SHALL disable local Mastra
   orchestration Workers.
2. WHEN `worker` starts THEN it SHALL enable only the orchestration Worker and
   SHALL require an authenticated HTTPS step-execution URL.
3. WHEN required role configuration is absent or contradictory THEN the process
   SHALL exit before migration or serving traffic.
4. WHEN a process receives SIGTERM THEN it SHALL first become unready, stop
   accepting work, drain within a bounded deadline, and close owned resources.

### PR-3: bounded workflow recovery

**User story:** As an operator, I need every run to reach a recoverable terminal
state so that crashes do not create permanently stuck or silently duplicated
work.

1. WHEN a workflow exceeds its execution deadline or heartbeat window THEN a
   reconciler SHALL move it to a retryable or terminal failure state.
2. WHEN retries are exhausted THEN the failure SHALL enter a persisted failure
   inbox with an audited re-drive operation.
3. WHEN a side-effecting step is retried THEN its idempotency key SHALL be stable
   and the persisted receipt SHALL prevent duplicate effects.
4. WHEN API, Worker, Redis, or Sandbox is killed during a test run THEN the run
   SHALL recover or fail within the documented recovery window.

### PR-4: multi-replica data correctness

**User story:** As a user, I need run state and evidence to remain available
from every replica so that failover and rolling deployment do not lose work.

1. WHEN an artifact is persisted in distributed production THEN it SHALL be
   stored in a shared object store with an owner-scoped key, checksum, content
   type, encryption, and retention metadata.
2. WHEN any API replica serves an artifact THEN it SHALL authorize the owner and
   stream the object without trusting a caller-provided filesystem path.
3. WHEN two writers update the same run revision THEN one update SHALL succeed
   and the other SHALL receive an explicit revision conflict instead of silently
   overwriting state.
4. WHEN a Slack delivery is accepted THEN deduplication and queue ownership SHALL
   be shared across replicas; overload SHALL return a visible retryable outcome
   rather than dropping the oldest message.

### PR-5: explicit tenant and connection ownership

**User story:** As an enterprise administrator, I need organization membership
and integrations to be explicit so that a verified email domain alone cannot
grant access to another customer's data.

1. WHEN a user authenticates THEN the system SHALL resolve an active membership
   in an explicit organization; it SHALL NOT derive authorization solely from
   the email domain.
2. WHEN a user is suspended or removed THEN all sessions, API tokens, roles, and
   integration access SHALL be revocable within the documented SLA.
3. WHEN a tool is resolved for a request THEN every Slack, Jira, MCP, and GitHub
   credential SHALL come from a connection bound to that request's tenant.
4. IF multi-tenant mode is enabled THEN process-global external service
   credentials SHALL cause startup to fail.
5. WHEN tenant A and tenant B use the same feature THEN automated negative tests
   SHALL prove that neither can enumerate or use the other's connection.

### PR-6: operational and disaster recovery contract

**User story:** As an operator, I need health, capacity, backup, and recovery
signals so that service state is measurable and recoverable.

1. WHEN readiness is evaluated THEN each dependency check SHALL have a deadline
   and SHALL cover the dependencies required by that process role.
2. WHEN queue lag, stuck runs, Sandbox capacity, dependency failures, or model
   cost cross a threshold THEN an actionable metric and alert SHALL identify the
   tenant, instance, version, and run without exposing content or credentials.
3. WHEN a release changes the schema THEN a single pre-deploy job SHALL apply an
   expand/contract migration compatible with both N and N-1 application versions.
4. WHEN a restore drill is run THEN PostgreSQL, credentials, workflow snapshots,
   and artifacts SHALL meet an approved RPO and RTO and SHALL pass integrity
   checks.

### PR-7: production evidence and immutable release

**User story:** As a release owner, I need one auditable release manifest to
bind every role artifact that passes the same gates from source to production
so that a release can be trusted and rolled back.

1. WHEN a pull request changes a production path THEN CI SHALL run unit,
   integration, real-browser, tenant-isolation, migration, and image smoke gates
   appropriate to that path.
2. WHEN a release candidate is built THEN the pipeline SHALL produce separate
   immutable service and Sandbox OCI digests, per-image SBOMs, vulnerability
   reports, signatures, and provenance, bound to one signed commit-specific
   release manifest.
3. WHEN the same release manifest is promoted through staging and production
   THEN automated end-to-end, failure-injection, and rollback tests SHALL record
   the result for both bound digests.
4. WHEN Agent behavior changes THEN a redacted regression set SHALL enforce
   approved quality, safety, latency, and cost thresholds.

## Architecture decisions

### AD-1: portable signed Sandbox claims

The public reference implementation uses a short-lived HMAC-signed JWT issued
by the API and verified by the Sandbox. The token is bound to a hash of the
strict claim request and a lease generation. The signing key is dedicated to
this purpose and never enters the task environment. Production platforms SHOULD
add mTLS or workload identity and network policy as a second boundary.

### AD-2: credentials stay in trusted preparation, not task environments

GitHub personal access tokens are used only by the trusted Sandbox runtime to
authorize and refresh its preparation mirror and create an independent checkout.
There is no task-reachable repository broker. The generic shell, code Agent,
worker environment, detached checkout, and fixed-check descendants never receive
`GH_TOKEN`, `GITHUB_TOKEN`, a Git authorization header, or a broker bearer token.
Model credentials are excluded from the initial worker environment, transferred
once over stdin, retained only in the trusted worker's memory, and hidden from
repository-controlled child processes by a nested PID/mount namespace.

### AD-3: explicit process roles

The entrypoint owns Mastra role variables rather than relying on operator
knowledge. API sets `MASTRA_WORKERS=false`; Worker sets
`MASTRA_WORKERS=orchestration` and requires `MASTRA_STEP_EXECUTION_URL`. Startup
validation and CI assert this contract.

### AD-4: shared artifacts behind an interface

`ArtifactStore` remains the application boundary. Local storage is supported
only for development and standalone deployments. Distributed production uses
an S3-compatible implementation selected by configuration. Database records
store opaque object keys, never host-local paths.

### AD-5: optimistic run state machine

Runs receive a monotonically increasing revision. Mutations use compare-and-set
and validate allowed status transitions in the repository transaction. Callers
must reload and deliberately retry a revision conflict.

### AD-6: tenant-bound connection registry

Organizations, memberships, sessions, and external connections are application
data. Runtime tool discovery receives a trusted tenant ID and resolves only the
connections owned by it. Legacy environment connections are allowed only in an
explicit single-tenant compatibility profile.

### AD-7: reliability layer complements native workflows

Mastra remains the workflow execution engine. Qasey adds a persisted failure
inbox, heartbeat/reconciler, idempotency receipts, and operator re-drive around
the native engine; it does not introduce a second general-purpose workflow
engine.

### AD-8: trusted service and untrusted Sandbox images are separate

The service image contains only API, Worker supervisor, migration, and Admin UI
artifacts on a minimal Node runtime. The Sandbox image alone contains browser,
desktop, repository, compiler, Python, and bubblewrap tools, and its fixed
entrypoint accepts only the Sandbox role. A release manifest binds both signed
digests to the same source commit; deployment IAM, secrets, network policy, and
resource limits remain role-specific.

## Implementation and evidence tasks

- [x] 1. Secure Sandbox boundary (PR-1)
  - [x] 1.1 Add signed, expiring, request-bound claim tokens and negative tests.
  - [x] 1.2 Require secure production endpoint/isolation configuration.
  - [x] 1.3 Remove GitHub credentials from task and shell environments.
  - [x] 1.4 Give each Code Task an independent no-hardlink/no-alternates checkout,
    run repository-controlled checks in a nested task-only PID/mount namespace,
    and run headless Chromium in a separate browser-only namespace with atomic
    state/frame persistence. Expose only the required read-only runtime closure
    and writable paths, reject the shared desktop backend in production, and
    prove the exact Sandbox image cannot observe sibling/host files, task control
    state, browser data, or control-plane/model credentials.
  - [x] 1.5 Fail closed at one untrusted session per production Sandbox process
    and require the pod/VM supervisor to enforce CPU, memory, PID, and
    ephemeral-storage limits. The repository CI proves the explicit non-root,
    capability-free Docker user-namespace contract; each production runtime
    still needs target-kernel admission evidence before GA.
- [ ] 2. Correct distributed runtime contract (PR-2)
  - [x] 2.1 Set and validate role-specific Mastra environment variables.
  - [x] 2.2 Add bounded drain and lifecycle integration.
  - [x] 2.3 Add role-specific readiness and static topology contract tests.
  - [ ] 2.4 Run multi-replica failover and N/N-1 rolling-deployment tests in staging.
- [ ] 3. Make state multi-replica safe (PR-4)
  - [x] 3.1 Add S3-compatible artifact storage and safe streaming downloads.
  - [x] 3.2 Add run revision/CAS and transition tests.
  - [x] 3.3 Add Redis-backed Slack state, deduplication, queue ownership, and bounded overload signals.
  - [ ] 3.4 Persist the raw verified Slack event before HTTP acknowledgement; the current upstream adapter acknowledges before Qasey's handler can durably admit the event.
- [ ] 4. Close workflow recovery gaps (PR-3)
  - [x] 4.1 Add heartbeat, stuck-run reconciler, and persisted failure inbox.
  - [x] 4.2 Add audited re-drive and idempotency receipt coverage.
  - [ ] 4.3 Execute API/Worker/Redis/Sandbox kill tests against the distributed staging topology.
- [x] 5. Close tenant and connection gaps (PR-5)
  - [x] 5.1 Add organization, membership, invitation, opaque session, and verified-domain models.
  - [x] 5.2 Add tenant-bound Slack, Jira, MCP, and GitHub connection storage and resolution.
  - [x] 5.3 Add immediate membership rechecks, revoke/deprovision, and cross-tenant negative tests.
  - [x] 5.4 Add an explicit, encrypted, short-lived organization-selection flow for users with multiple active memberships, including membership rechecks and browser negative tests.
- [ ] 6. Complete operations and release gates (PR-6, PR-7)
  - [x] 6.1 Add dependency and HTTP RED metrics, starter SLO/burn-rate rules, traffic-governance signals, `promtool` CI validation, and runbooks.
  - [ ] 6.2 Exercise alert routing, tune tenant budgets, and assign an on-call owner.
  - [x] 6.3 Add one-shot pre-deploy migration, expand-only migration gates, safe PostgreSQL/S3 restore tooling, and integrity checks.
  - [ ] 6.4 Execute a production-like restore drill and approve its RPO/RTO evidence.
  - [x] 6.5 Add a real-browser Admin UI gate and failure artifacts.
  - [x] 6.6 Add a public synthetic Agent regression contract with strict schemas, safety/tool-effect/latency/cost thresholds, canonical digesting, and a fail-closed live-report validator.
  - [x] 6.7 Add role-isolated service/Sandbox digests, exact-candidate service/PostgreSQL and Sandbox/bubblewrap/browser smokes, task-level execution-image provenance assertions, two-image pre-publication vulnerability gates, per-image SBOMs/signing/provenance, and a signed commit-bound release manifest.
  - [ ] 6.8 Promote the same release manifest and both bound digests through staging, record provider canaries and rollback evidence, and approve it for production.
  - [x] 6.9 Add pre-auth streaming body limits, distributed tenant/subject quotas, high-cost request budgets, TTL-bounded concurrency leases, and explicit 429/503 behavior.
  - [x] 6.10 Add versioned read-old/write-new keyrings and CAS re-encryption for external connections, Slack installations, and persisted OAuth MCP credentials.
  - [x] 6.11 Run application-layer cross-tenant negative tests against a real migrated PostgreSQL service in CI.
  - [ ] 6.12 Execute provider-backed Agent evals, load/soak tests, and provider failure matrices against the promoted release.
  - [x] 6.13 Generate and frozen-install a Sandbox-only Node dependency closure for the bundle's six external imports (`@ai-sdk/openai`, `@mastra/core`, Playwright, CUA driver, `jose`, and `zod`), while retaining lock/workspace security overrides and excluding Prisma, PostgreSQL, Slack, repository, and observability connectors. The exact-candidate image gate additionally proves bubblewrap mount/PID/environment isolation for a real Code Task and a sandboxed Chromium session.

## Open GA blockers

| Priority | Blocker | Completion evidence |
| --- | --- | --- |
| P0 | Slack's current Chat SDK path sends HTTP 200 before the application handler can persist the verified raw event. Redis-backed post-handler state cannot retroactively make that acknowledgement durable. | Upgrade or patch the adapter to expose verify-then-dispatch hooks; persist to a durable stream before ACK; prove overload returns a retryable HTTP outcome. |
| P0 | Distributed failover, kill, rolling upgrade, and rollback have not run against real API, Worker, Redis, Sandbox, PostgreSQL, and object-storage replicas. | Signed staging report showing bounded recovery, no lost artifact, no stuck run, and no duplicate provider write. |
| P0 | The disaster-recovery implementation has not yet restored a production-like PostgreSQL backup and versioned artifact recovery point. | Independently reviewed evidence meeting the documented 15-minute RPO and four-hour RTO. |
| P1 | The public Agent contract and live-report validator are present, but no provider-backed runner evidence exists for the promoted model/release. Offline fixture validation is deliberately not a quality claim. | Complete live report for every canonical case, bound to the dataset and release digests, meeting quality, 100% safety/tool-effect, latency, and cost gates. |
| P1 | Bubblewrap requires unprivileged namespace syscalls and unmasked proc mounts that stock OCI seccomp and AppArmor profiles commonly block. CI exercises a capability-free Docker compatibility exception, while the Kubernetes 1.36+ template fails closed on a dedicated RuntimeClass/node pool and pre-provisioned Localhost profiles; no target production runtime has yet approved or exercised those seccomp/AppArmor (or SELinux, where applicable) policies. | Security-reviewed runtime profiles, dedicated Baseline namespace/admission policy, RuntimeClass, and isolated node pool; exact signed Sandbox digest passes readiness, Code Task, browser, egress, and escape tests without privileged mode or added capabilities. |
| P1 | Repository quotas, egress checks, alert rules, release attestations, keyrings, and provider adapters have not been exercised with production IAM, traffic shape, DNS/network policy, secret manager, and on-call routing. | Load/soak and abuse results; alert fire/recovery records; egress and key-rotation drills; read-only Slack/Jira/GitHub/MCP/S3 canaries for the promoted digest. |

## GA exit criteria

Qasey may be described as enterprise production-ready only when:

1. every P0 task above is complete or has a time-bounded, owner-approved risk
   acceptance;
2. the supported distributed topology passes multi-replica failover and rolling
   deployment tests without lost artifacts, stuck runs, or duplicate external
   writes;
3. a production-like restore drill meets the approved RPO/RTO;
4. SLOs, alerts, on-call ownership, and runbooks have been exercised; and
5. the exact signed release manifest and both bound digests promoted to
   production have passed all required security, migration, end-to-end, and
   Agent regression gates.
