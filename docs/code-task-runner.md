# Code Task Runner

## Repository storage invariant

Within one Sandbox replica, one canonical repository has one trusted Git mirror
used only to prepare attempts. Every attempt receives a full, independent
checkout pinned to an immutable base SHA. The checkout has its own `.git`
directory and copied object files: it has no worktree pointer, alternates file,
or hardlink back to the shared mirror.

```text
Sandbox replica
├── git-cache/code-task-repository-pool-v1/<repository-key>.git
│   └── objects/                         # trusted preparation cache
└── code-tasks/<workspace-id>/<task-id>/<attempt-id>/
    ├── repositories/target/.git/objects # private, no hardlinks/alternates
    ├── repositories/reference/.git/     # optional read-only secondary repo
    ├── control/                         # worker state, never task-code mounted
    ├── artifacts/                       # terminal immutable read layer
    └── check-output/                    # fixed-check private HOME/output
```

The first authorized use creates the mirror. Every later use refreshes it
and performs `git clone --local --no-hardlinks --no-checkout`, followed by an
exact detached checkout and `HEAD` verification. The mirror is never mounted
into a task namespace. This deliberately trades some disk deduplication for a
security invariant: untrusted Git commands cannot mutate or traverse metadata
shared by another tenant or attempt. Attempt data is removed by the configured
workspace retention policy.

## Authorization boundary

The trusted Sandbox runtime obtains the current GitHub read credential and uses
it only for the mirror refresh and isolated checkout preparation. A cache hit
does not bypass authorization: refresh must succeed before a checkout is handed
to a task. The mirror and checkout store credential-free canonical remote URLs.
GitHub tokens, `extraHeader`, and Git credential configuration are not copied
into the checkout or worker process; there is no task-reachable repository
broker endpoint or broker bearer token.

The shared preparation store is keyed by canonical repository within the
Sandbox replica, not by session. The only repository filesystem visible to the
Agent remains its private attempt checkout. Secondary `read` repositories are
mounted read-only and their pinned `HEAD`, status, and tree hash are checked
again after all deterministic checks.

## Mastra and Git responsibilities

Git lifecycle is owned by `CodeTaskRunner` and the Sandbox runtime:

1. Authorize and refresh the shared repository store.
2. Validate that the frozen base SHA exists.
3. Create an attempt-specific detached, independent checkout.
4. Start the `code-task-worker` process in that independent checkout.
5. Collect and validate the patch and artifacts.

Inside the worker, Mastra `LocalFilesystem` is rooted at that checkout with
containment enabled. A dedicated native Mastra `Agent` receives the repository
Workspace and discovers only the frozen repository-local Skill paths. Write
tools are guarded both by the frozen `allowedPaths` and by canonical nearest-
ancestor checks, so an allowed lexical path cannot escape through a symlink.
Delete and arbitrary shell tools are not exposed. Mastra provides the Agent's
file boundary; it does not clone repositories, choose checkouts, or decide
which checks to run.

Model credentials are excluded from the worker's initial environment and sent
once as a bounded JSON line over the worker's stdin. They remain in the trusted
worker's memory. Repository-controlled install and Playwright processes run in
a second bubblewrap PID/mount namespace which cannot see the worker process,
control state, final artifact root, or credentials through `/proc`.

Author, repair, and verifier attempts therefore share only a trusted preparation
cache, never Git objects mounted at runtime, a working directory, or an Agent
session. The verifier always receives the persisted patch in a fresh detached
checkout. Completed artifacts become readable only after terminal state through
the `sandbox://code-task-artifacts/...` virtual read-only layer; the active task
root is not exposed through the generic session filesystem.

`qasey-main` remains the supervisor and lifecycle entrypoint, but it does not
receive repository write access. The durable E2E workflow invokes the dedicated
code Agent in the isolated execution plane. This keeps lifecycle decisions,
repository mutation, and deterministic verification as separate trust zones.

## Fixed Web E2E configuration

The deployment-owned repository configuration is selected by
`QASEY_E2E_REPOSITORY_CONFIG_FILE`. Start by copying
`config/e2e-repository.example.json` to the ignored
`config/e2e-repository.json` file.
It owns:

- the target repository and base ref;
- writable paths for tests, page objects, and helpers;
- the Playwright config and project name for each product project.

Neither an API caller nor the coding Agent can provide a command or replace the
verification mapping. The Service strictly parses the target and mapping in one
read when it creates a run, persists that server-owned snapshot, includes it in
the hashed execution brief, and copies it into every Code Task spec. The
Sandbox image does not contain or mount the ignored deployment file, and the
deployed source SHA is likewise taken from the build artifact rather than an
Agent/API field or a manually maintained Qasey environment variable. The
worker never reads it. Missing, malformed, duplicate, escaping, partially
covered, or unmatched mappings fail closed; legacy in-flight runs without a
snapshot must be recreated.

After the patch is present, the worker derives the affected project only from
the frozen mapping and changed paths.
When changed spec files exist, it invokes the repository-local Playwright CLI
for those specs. When only project support code changed, it invokes the whole
affected project. A path outside every configured project fails closed.

With the redacted example configuration, a Web project change becomes:

```text
pnpm exec playwright test <changed Web specs>
  --config=web/playwright.config.ts
  --project=chromium
```

Reports, JUnit output, logs, and test results are written under the attempt
artifact directory rather than the repository checkout.

## Execution environment mapping

Qasey's Sandbox deployment uses a namespaced setting so repository-specific
names do not become part of the generic Runner contract. The Web E2E execution
profile derives the target repository environment:

```text
QASEY_E2E_BASE_URL -> BASE_URL
```

The configured E2E repository reads `BASE_URL`. If `QASEY_E2E_BASE_URL` is absent
from the Sandbox runtime, no alias is injected and the repository's own default
remains active. Request payloads cannot provide either value. Model credentials
and the matching `OPENAI_BASE_URL`, when configured, are available only to
Agent-backed author, repair, and read-only review profiles. They are absent
from the deterministic verifier profile.

## Local verification

The normal development command starts the complete control and execution
planes. It builds the worker entrypoints, starts one local Sandbox runtime,
ensures the repository's Chromium version exists in Playwright's host-level
shared cache, waits for Sandbox readiness, and then starts Mastra. Task-private
homes receive `PLAYWRIGHT_BROWSERS_PATH`, so attempts do not download their own
browser copies:

```bash
pnpm dev
```

No E2E execution, Sandbox, shadow, or Draft PR feature flags exist. Runtime
capability is structural: a configured Sandbox endpoint creates the
`CodeTaskRunner`; without one, E2E submission fails before a queued run is
persisted. `pnpm dev` injects its loopback endpoint automatically. Production
must configure the pool endpoint explicitly. Draft PR publication occurs after
the clean verifier whenever GitHub App publishing credentials are available.

The deterministic storage, lifecycle, path, and check-planning tests run with:

```bash
pnpm exec vitest run \
  tests/e2e/repository-cache.test.ts \
  tests/code-task \
  tests/platform/sandbox-runtime.test.ts
```

A live author/verifier test additionally requires the built Sandbox worker,
model credentials for authoring, a control-plane GitHub read credential for the
private repository, Case Hub access, target repository package access, and the
Playwright browsers. `QASEY_IMAGE_DIGEST` is not required locally.
Production sandbox startup rejects a missing or non-immutable value, and the
exact release smoke asserts that every task provenance record matches the
digest-addressed candidate that executed it.
