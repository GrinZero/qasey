# Code Task Runner

## Repository storage invariant

Within one Sandbox replica, one canonical repository has one Git mirror/object
store. Sessions, tasks, and attempts never clone that repository again. They
only create independent Git worktrees pinned to an immutable base SHA.

```text
Sandbox replica
├── git-cache/code-task-repository-pool-v1/<repository-key>.git
│   ├── objects/                         # shared once
│   └── worktrees/                       # Git administrative metadata
└── workspaces/<workspace-id>/repo/code-tasks/
    ├── <task-id>/<author-attempt>/repositories/target
    ├── <task-id>/<repair-attempt>/repositories/target
    └── <task-id>/<verifier-attempt>/repositories/target
```

The first authorized use creates the mirror. Every later use refreshes it
through the repository broker and creates a worktree directly from the same
store. There is no session-local or attempt-local bare clone. Missing worktree
directories are pruned from Git metadata before a new worktree is added.

This deduplicates Git objects, which are often the largest persistent part of
a repository checkout. Worktree files and attempt-local `node_modules` still
consume space; package-manager content-addressable stores may deduplicate
package contents, but this design does not claim that worktrees are free.

## Authorization boundary

The repository broker obtains the current GitHub read credential and performs
the mirror clone or refresh. A cache hit does not bypass authorization: refresh
must succeed before a worktree is handed to a task. The mirror stores a
credential-free canonical remote URL. GitHub tokens, `extraHeader`, and Git
credential configuration are not copied into the worktree or worker process.

The shared store is keyed by canonical repository within the Sandbox replica,
not by session. This is a storage optimization only. The writable filesystem
visible to the Agent remains its attempt worktree.

## Mastra and Git responsibilities

Git lifecycle is owned by `CodeTaskRunner` and the Sandbox runtime:

1. Authorize and refresh the shared repository store.
2. Validate that the frozen base SHA exists.
3. Create an attempt-specific detached worktree.
4. Start the `code-task-worker` process in that worktree.
5. Collect and validate the patch and artifacts.

Inside the worker, Mastra `LocalFilesystem` is rooted at that worktree with
containment enabled. A local Mastra `Workspace` is passed to `AcpAgent`, which
starts `codex-acp`. Mastra provides the Agent's file boundary; it does not clone
repositories or choose worktrees.

Author, repair, and verifier attempts therefore share Git objects but never a
working directory or ACP session. The verifier always receives the persisted
patch in a fresh detached worktree.

## Fixed Web E2E configuration

The versioned repository configuration lives in
`src/mastra/agents/qasey-main/skills/e2e-lifecycle/references/repositories.json`.
It owns:

- the fixed `MoeGolibrary/moego-e2e-autotest` repository and base ref;
- writable paths for BWeb, OBC, and Enterprise tests, page objects, and helpers;
- the Playwright config and project name for each product project.

Neither an API caller nor the coding Agent can provide a command. After the
patch is present, the worker derives the affected project from changed paths.
When changed spec files exist, it invokes the repository-local Playwright CLI
for those specs. When only project support code changed, it invokes the whole
affected project. A path outside every configured project fails closed.

Conceptually, a BWeb change becomes:

```text
pnpm exec playwright test <changed BWeb specs>
  --config=project/BWeb/playwright.config.ts
  --project=t2
```

Reports, JUnit output, logs, and test results are written under the attempt
artifact directory rather than the repository worktree.

## Execution environment mapping

Qasey's Sandbox deployment uses a namespaced setting so repository-specific
names do not become part of the generic Runner contract. The Web E2E execution
profile derives the target repository environment:

```text
QASEY_E2E_BASE_URL -> BASE_URL
```

`moego-e2e-autotest` reads `BASE_URL`. If `QASEY_E2E_BASE_URL` is absent from
the Sandbox runtime, no alias is injected and the repository's own T2 default
remains active. Request payloads cannot provide either value. Model credentials
are absent from the verifier profile.

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
model credentials for authoring, GitHub broker credentials for the private
repository, MeterSphere access, target repository package access, and the
Playwright browsers. `QASEY_IMAGE_DIGEST` is not required locally.
