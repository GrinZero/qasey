# Qasey Case Hub

Case Hub is the sole source of truth for manual test cases. Git stores only the
Playwright implementation. The first release has one project (`QASEY`), Web,
Chromium, and a strict one-test-to-one-case mapping.

## Formal library boundary

The Case Hub list and `case_hub_search_cases` expose only Cases with an
`activeVersionId`. A Case becomes active only after its latest execution result
is approved by QA and the delivery Pull Request is reported as merged by the
GitHub lifecycle. Approval without merge is not entry into the library.

Proposal creation assigns an optimistic, stable-within-the-Change-Set
`QASEY-*` candidate ID so automation, evidence, and review records can refer to
it. The project sequence advances atomically only after every latest Result in
the Change Set is approved. Failed, cancelled, abandoned, and otherwise
unapproved attempts therefore do not consume formal Case numbers. If another
Change Set finalizes the same optimistic range first, the stale Change Set must
be regenerated instead of silently renumbering already verified code. Until activation, the Case and candidate
version remain available only through Change Set, run, and review APIs. Failed,
rejected, pending, and approved-but-unmerged candidates do not appear in Case
Hub search or detail responses. A candidate update cannot change the visible
title, Suite, or payload of an already active Case; those fields switch together
only when `activateApprovedVersions` activates the merged version.

## Change lifecycle

1. The Agent freezes the conversation as a redacted Requirement Snapshot.
2. `case_hub_search_cases` identifies existing coverage.
3. `case_hub_create_change_set` stores immutable create/update proposals.
4. A Native Mastra CodeTask authors Playwright in an isolated checkout.
5. A fresh verifier applies the patch and emits JSON/HTML reports, traces,
   screenshots, and videos configured by the target repository.
6. Reviewers decide each latest Result independently: approve, request changes,
   product bug, or environment issue.
7. A requested change carries only that Case Version into the next Attempt.
8. Once every latest Result is approved, the Draft PR becomes Ready. Qasey does
   not merge it.
9. A signed, delivery-id-deduplicated GitHub webhook activates approved Case
   Versions after merge. Closing without merge abandons the Change Set. A
   service-only `POST /internal/case-hub/change-sets/:id/reconcile` endpoint
   actively reconciles missed pull-request deliveries.

Results are append-only. A rerun creates a new Attempt and never overwrites old
evidence. Product and environment blockers do not trigger assertion weakening.

## Admin task conversations

`/admin/apps/qasey` is a persistent QA task conversation rather than a one-shot
prompt. Each conversation has a tenant-and-subject-owned Mastra thread/resource,
one active turn at a time, and a replayable event sequence. The Admin UI uses:

- `GET|POST /v1/qasey/conversations` to list and create tasks;
- `GET /v1/qasey/conversations/:conversationId` to restore a deep link;
- `POST /v1/qasey/conversations/:conversationId/messages` for an idempotent
  `clientMessageId` and AI SDK v6 UI Message Stream response;
- `GET /v1/qasey/conversations/:conversationId/turns/:turnId/events` to resume
  after the last received sequence.

The database retains the internal `accepted`, `assistant.delta`, `progress`,
`tool.started`, `tool.finished`, `run.linked`, `completed`, and `failed` event
log. API reads project that log into stable `QaseyUIMessage` records, while live
responses expose text, curated `data-progress`, native dynamic-tool lifecycle
parts, `data-run`, and hidden `data-cursor` parts. Business-relevant tools expose
their technical name plus bounded input/result summaries; progress-reporting and
clock utilities stay hidden. Raw tool arguments, raw results, credentials,
internal errors, and reasoning never cross the conversation API.
The browser uses the cursor to request only missing events; closing the browser
does not cancel the durable Agent execution. Once a turn links an E2E run, the
Admin UI follows the separate run event stream until a terminal state.
`/v1/qasey/tasks` remains available as an isolated one-shot compatibility
endpoint. The retired `/admin/apps/qasey/workspace` route intentionally returns
the Admin 404 view; backend sandbox/runtime APIs remain available for automation
and existing integrations.

## Test environment and login

The build automatically stamps the checked-out Git commit into a runtime
artifact. The Workflow freezes that observed value on the Change Set and blocks
when it differs from the repository base SHA; callers cannot submit or override
it. Generic target verification uses the target repository's checked-in
Playwright setup project. Qasey supplies `BASE_URL` and only the secret variable
names declared by the repository configuration to the non-Agent verifier. The
setup performs the login and owns any storage-state file under an ignored test
output path. Those variables do not enter prompts, Change Set JSON, logs, PRs,
or artifacts.

The target repository's project Skill identifies the test-account class,
role/tenant, login route, setup file, and cleanup rules. Qasey's Sandbox verifier
receives the declared variables from the deployment secret source and runs the
configured Playwright project. The internal `/internal/e2e/leases` API is
reserved for explicit Qasey service tests and is not used to authenticate an
arbitrary target product.

## Native CodeTask rollout

API, orchestration worker, and sandbox images must be deployed together. Before
the switch, stop new CodeTasks and drain active author, repair, and verifier
attempts. Mark timed-out attempts `lost`; keep their artifacts read-only and
create a fresh Native Attempt on the same Run. Do not restore an old agent
session.

The sandbox `/readyz` response must advertise only the `native-mastra`
capability before intake resumes. `pnpm check:native-code-task` rejects legacy
agent protocol packages, commands, environment variables, and provenance fields
from tracked source, manifests, and the lockfile.
