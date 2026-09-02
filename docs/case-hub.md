# Qasey Case Hub

Case Hub is the sole source of truth for manual test cases. Git stores only the
Playwright implementation. The first release has one project (`QASEY`), Web,
Chromium, and a strict one-test-to-one-case mapping.

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

## Test environment

The service audience can read `GET /internal/e2e/version`, create a TTL-bound
fixture lease with `POST /internal/e2e/leases`, and idempotently clean it with
`DELETE /internal/e2e/leases/:id`. The build automatically stamps the checked-out
Git commit into a runtime artifact. The Workflow freezes that observed value on
the Change Set and blocks when it differs from the repository base SHA; callers
cannot submit or override it. Each fresh verifier obtains a lease directly from
the shared in-process fixture service, receives `QASEY_E2E_BASE_URL` plus a
one-shot Playwright storage-state file, and releases the lease in a `finally`
path with idempotent retries. `PLATFORM_SERVICE_TOKEN` authenticates external
service callers of the HTTP API only and is not used for Qasey self-calls.

The opaque browser token crosses only the authenticated sandbox start request;
the sandbox runtime materializes it as a mode-0600 storage-state file for the
non-Agent verifier. It is not part of the CodeTask spec or manifest, prompts,
Change Set JSON, logs, PRs, or artifacts.

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
