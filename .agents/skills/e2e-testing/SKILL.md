---
name: e2e-testing
description: Write or repair Playwright coverage using the target repository's executable login, account, Sandbox, test-data, locator, and cleanup contract.
---

# Repository Web E2E contract

Use this Skill before changing Playwright specs, page objects, fixtures, setup projects, or configuration.

## Know what is being verified

- `tests/browser/admin-ui.spec.ts` is this repository's route-mocked Admin UI contract suite. It runs with `pnpm test:browser` in `.github/workflows/ci.yml`. It uses no live account and does not prove that a deployed product can log in.
- A live target-repository E2E suite is valid only when that repository checks in an executable Playwright authentication setup that the Qasey Sandbox verifier can run. Qasey does not invent an account, tenant, cookie, or storage state for another product.
- Never silently convert a mocked UI contract test into a live authenticated test.

## Qasey dogfood identity

- Account class: one stable, dedicated Qasey password account owned by the QA/deployment operator. It is not created per run and must not be a personal or production customer account.
- Tenant: the account must have an active membership in the non-production organization named by `E2E_TEST_TENANT_ID`. For local Runtime Compose, set it to `local`, matching `QASEY_SINGLE_TENANT_ID=local`.
- Role: the authenticated principal must include `user`. Add the account to `PLATFORM_LOCAL_ADMIN_EMAILS` only when an accepted Case explicitly covers development-only platform-admin screens; ordinary dogfood coverage must not assume that bypass.
- Login: `POST /auth/password/login`, implemented by `tests/browser/auth.setup.ts` in the Playwright `setup` project. Authenticated Chromium depends on that project.
- Credentials: `E2E_LOGIN_EMAIL` and `E2E_LOGIN_PASSWORD`. The setup also requires `E2E_TEST_TENANT_ID` and proves the returned session belongs to that tenant before saving browser state.
- Lifecycle: an operator registers the account once in the configured non-production tenant, rotates the password in the Qasey deployment secret source, and suspends/removes the membership when the account is retired. Test runs never register or repair the account automatically.

Secret values never belong in this Skill, source code, Playwright config, fixtures, logs, reports, or Git history. The ignored local `.env` provides them for local dogfood, while the Qasey deployment secret source provides them to the Sandbox verifier. If login or tenant verification fails, report an environment blocker rather than creating another account.

## Executable Playwright login

- Authenticate through `tests/browser/auth.setup.ts`; do not synthesize cookies or hand-write storage state.
- Read the deployment from `BASE_URL` and credentials only from the declared authentication environment variables.
- Make authenticated browser projects depend on the setup project and read the storage-state file produced under the task's temporary directory.
- Fail immediately with the missing variable names when configuration is incomplete. Never print their values.
- Keep login-screen tests anonymous. They may exercise the real login only when the accepted Case explicitly covers authentication and the target environment permits it.

The repository's normal Playwright dependency graph must make this command perform login before the selected browser project:

```text
pnpm exec playwright test <specs> --config=<checked-in-config> --project=<checked-in-project>
```

Qasey's clean verifier supplies `QASEY_E2E_BASE_URL` as `BASE_URL` plus only the declared secret variables, then runs that command in a clean checkout. The authoring Agent never receives those credentials. Preflight verifies the Skill, authentication setup, Playwright dependency graph, declared environment names, deployment version, and Sandbox-reachable test environment before a Run can be created.

## Test data and isolation

- Use the repository's supported UI or API helpers to create only the records required by the Case.
- Generate collision-resistant data and clean it in teardown. Do not depend on execution order or existing tenant data.
- Do not mutate billing, production integrations, real customer data, or irreversible external systems.
- Assert stable user-visible behavior, not the secret account email, tenant id, timestamps, or generated record ids.

## Repository conventions

- Live dogfood Case automation must use a filename matched by `tests/browser/playwright.config.ts`: `tests/browser/*.e2e.spec.ts`. Never assign a live Case to `tests/browser/admin-ui.spec.ts`; that file belongs to the route-mocked UI contract suite and is excluded from clean dogfood verification.
- Reuse existing page objects, fixtures, and accessible locators. Prefer role, label, and exact visible text over CSS structure or sleeps.
- Map exactly one Playwright test to one Case Hub case. Include the `QASEY-N` id in the title and exactly one `qasey.case` plus one `qasey.version` annotation from the frozen Case.
- Keep meaningful assertions and failure artifacts. Do not use `test.only`, unapproved skips, conditional pass paths, or weakened assertions.
- When this Skill does not contain enough target-specific account or setup detail, report that as a blocker instead of guessing.

## Maintaining this Skill

The Skill validator's Python dependency is pinned next to this file. After changing the Skill, validate it with:

```text
uv run --with-requirements .agents/skills/e2e-testing/requirements.txt python .agents/skills/e2e-testing/scripts/quick_validate.py .agents/skills/e2e-testing
```
