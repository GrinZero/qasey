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
