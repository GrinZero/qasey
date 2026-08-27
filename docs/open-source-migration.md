# Open-source migration

This document is the acceptance map for turning the former private deployment
into a community-owned project. A phase is complete only when its evidence is
present in the repository and covered by an automated check.

## Target architecture

- **Runtime:** one Mastra composition root with application-owned agents and
  workflows; no private framework fork or organization package registry.
- **Configuration:** deployment-owned environment variables loaded with Node's
  stable `.env` parser; only redacted examples are tracked.
- **Database:** standard PostgreSQL through Prisma. Supabase is one documented
  managed option, not a runtime dependency.
- **Authentication:** Google OIDC and default-enabled single-tenant password
  accounts are the implemented browser identity providers. Both enter the same
  opaque-session, membership, RBAC, and audit boundary.
- **Integrations:** Slack, Jira, GitHub, MCP, Sandbox, and Datadog are real
  public integrations. They remain opt-in and must not be readiness gates when
  disabled.
- **Execution:** local development uses Docker Compose. Distributed production
  keeps API, orchestration worker, Redis, and sandbox roles explicit.
- **Observability:** Mastra storage is authoritative; Datadog remains optional.

## Work and evidence

| Area | Required outcome | Evidence |
| --- | --- | --- |
| Source and branding | No legacy organization names, domains, accounts, IDs, private repositories, or real tenant examples | `pnpm check:open-source` |
| Secrets | No committed runtime environment or embedded credentials | ignored `.env*`, redacted `.env.example`, secret scan |
| Dependencies | Install and Docker build use only public registries | `pnpm install --frozen-lockfile`, container build |
| Database | Local PostgreSQL and hosted Supabase both accept Prisma migrations | bootstrap test and migration smoke test |
| Infrastructure | Only infrastructure present in the source is migrated; absent Firebase/search products are not invented as work | dependency/source scan and architecture tests |
| CI/CD | Public GitHub Actions run checks without organization runners or reusable private workflows | `.github/workflows/ci.yml` |
| Community | Apache License 2.0, contributing guide, security policy, code of conduct, issue/PR templates | repository root and `.github` |
| Release | A sanitized public root commit, clean build, tests, migration rehearsal, container health probes, and source scan | `docs/public-release.md` and release checklist |

## Migration decisions

1. The legacy n8n snapshots were migration artifacts, not runtime dependencies.
   They contained tenant-specific configuration and were removed rather than
   published as examples.
2. Supabase initially replaces managed PostgreSQL only. Coupling the runtime to
   Supabase Auth, Storage, or its Data API would reduce portability and requires
   separate security review.
3. No Firebase or managed Agent Search client is present in the baseline. They
   are explicit non-goals rather than placeholder migrations.
4. Google OIDC and the other vendor integrations are public product features,
   not organization infrastructure. The extraction removes organization
   defaults and makes optional integrations opt-in; it does not rewrite them
   without evidence of a deployment blocker.
5. Deleting sensitive files from this branch is insufficient because the
   original blobs remain reachable from Git history. Public hosting must start
   from the sanitized snapshot root described in `docs/public-release.md`.

## Publication gates

- The rights holder approved Apache License 2.0. The public snapshot must
  contain the unmodified official license text and matching package metadata.
- `pnpm check` and `pnpm check:open-source` must pass in the source worktree.
- The release operator must create a new repository with
  `pnpm public:snapshot`, never push this extraction branch or its ancestors.
- The generated repository must pass `pnpm check:public-history`, a frozen
  install, migrations, `pnpm check`, and an image health smoke test.
