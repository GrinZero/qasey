# Contributing to Qasey

Thank you for helping make Qasey easier to run, understand, and extend.

## Before opening a change

1. Search existing issues and describe the user-facing problem before a large
   implementation.
2. Keep integrations optional and provider-neutral. A hosted adapter must not
   remove the self-hosted path.
3. Use synthetic fixtures. Never include customer conversations, real account
   identifiers, private repository names, internal endpoints, or credentials.
4. Add or update tests for behavior changes and document new environment
   variables in `.env.example` and `docs/configuration.md`.

## Development

```bash
sh scripts/bootstrap.sh
pnpm dev
```

Before submitting a pull request:

```bash
pnpm check
```

`pnpm check` runs the open-source boundary scan, type checking, unit and
integration tests, Admin UI build, Mastra API build, and worker build.

## Pull requests

Keep pull requests focused. Explain the motivation, migration impact, security
considerations, and verification evidence. Breaking configuration or database
changes require a migration note. Generated files and lockfiles must be updated
in the same pull request.

By participating, you agree to follow the project Code of Conduct.
Unless you explicitly state otherwise, contributions intentionally submitted
for inclusion in Qasey are provided under the Apache License 2.0 terms in
`LICENSE`.
