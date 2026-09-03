# Deployment

Qasey is a Node.js service backed by PostgreSQL. Supabase is one documented
managed PostgreSQL option, but no Supabase-specific SDK is required and any
compatible PostgreSQL service remains supported.

## Local bootstrap

Requirements: Node.js 24, Corepack, and Docker.

To run the complete local stack only with Docker:

```bash
docker compose -f docker-compose.yml -f docker-compose.runtime.yml up --build -d
```

`pnpm compose:runtime` is the equivalent repository shortcut.

This builds and starts the trusted service image, a single development Sandbox,
PostgreSQL, Redis, and a finite migration job. The application is available at
`http://localhost:4111/admin`. Set `OPENAI_API_KEY` in the ignored `.env` file
or the invoking shell before startup. The Sandbox is ready immediately, while
the unused distributed orchestration Worker artifact is omitted from this local
standalone build profile. Production image builds retain that artifact.
Code Task authoring remains fail-closed until an authorized
`config/e2e-repository.json` is created from the redacted example. Compose's
fixed local keys, HTTP-only internal Sandbox endpoint, and `isolation=none` are
development conveniences inside the outer container boundary; they are not a
production deployment profile.

The image build derives the deployed source commit from the checkout and writes
it to `.qasey/build-metadata.json`; the service image contains that artifact but
does not contain `.git`. Do not add a manually maintained source-SHA variable.
The Case Hub records this build fact and independently compares it with the
frozen repository base SHA before running the repository-owned E2E login setup.

For source development inside the same Linux and Node.js baseline, open the
repository with the checked-in `.devcontainer/devcontainer.json`. It combines
`docker-compose.yml` and `docker-compose.dev.yml`, mounts the source at `/app`,
and keeps the Sandbox in a separate container. After attaching, run:

```bash
pnpm dev:container
```

The external-Sandbox development mode intentionally skips the host Chromium
installation and local Sandbox child process. `pnpm compose:dev` can be used
before attaching an editor to the `development` service, and
`pnpm compose:dev:down` stops that stack. Development-only source mounts,
dependencies, and file watchers are not copied into either release image. The
development and runtime compositions use independent project names and volumes;
override the published application, PostgreSQL, and Redis ports before running
both at the same time.

For source development directly on the host:

```bash
sh scripts/bootstrap.sh
pnpm dev
```

The bootstrap script creates an ignored `.env`, starts PostgreSQL and Redis,
installs dependencies, and applies the checked-in Prisma migrations. Local
development uses PostgreSQL for application state and DuckDB for observability.
Redis is available for distributed-runtime testing but is opt-in locally.
If the default host ports are occupied, set `QASEY_POSTGRES_PORT` and
`QASEY_REDIS_PORT` in the ignored `.env` and update `DATABASE_URL` to match.

Stop the infrastructure without deleting its volumes:

```bash
pnpm infra:down
```

## Supabase PostgreSQL

1. Create a Supabase project and open **Connect** in its dashboard. The current
   direct/session/transaction guidance is maintained in Supabase's
   [official connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).
2. For a persistent container, copy either the direct connection string or the
   Supavisor session-mode string (port `5432`). Use session mode when the host
   cannot reach the direct IPv6 endpoint.
3. Store the URL as `DATABASE_URL` in the deployment platform. Never commit it.
4. Apply the schema from a trusted CI job or operator machine:

   ```bash
   DATABASE_URL='postgresql://...' pnpm db:migrate:deploy
   ```

Qasey does not expose the Supabase Data API and therefore does not depend on an
anonymous or service-role API key. Database access stays server-side through
Prisma. Supabase Auth and Storage are not silently enabled; adopting either is
a separate architecture decision because the current runtime owns its session,
authorization, and workspace boundaries.

## Production containers

Build the role-isolated public images without registry credentials. The default
Docker target is the trusted service runtime; name both targets explicitly in
automation:

```bash
docker build --target service-runtime -t qasey-service:local .
docker build --target sandbox-runtime -t qasey-sandbox:local .
```

Run secrets through the hosting platform's secret store. Do not bake `.env`
files into either image. `service-runtime` uses a minimal Node base without
Playwright, X11, bubblewrap, Git/GH/SSH, Python, or compiler tools. It supports
three trusted control-plane roles:

- `api` (default): HTTP API, Admin UI, and Studio. Standalone production keeps
  the community-friendly automatic migration behavior; distributed production
  never applies migrations from an API replica.
- `worker`: Mastra orchestration worker; set `WORKER_TOKEN`. The entrypoint
  passes the same value to Mastra as `MASTRA_WORKER_AUTH_TOKEN`, matching the
  API's dedicated `orchestration-worker` identity. Distributed Workers never
  apply migrations. Production Workers also require a distinct
  `QASEY_WORKER_METRICS_TOKEN` for their private health and metrics listener.
- `migrate`: a finite pre-deploy job that applies checked-in Prisma migrations
  and exits. It requires `DATABASE_URL` and must finish successfully before any
  new distributed API or Worker replica starts.

`sandbox-runtime` is the separate untrusted execution-plane image. Its fixed
entrypoint accepts only the `sandbox` role, and the image contains no API,
Worker supervisor, Prisma migration, or application configuration artifacts.
It retains the browser/desktop, repository, compiler, Python, and bubblewrap
toolchain required by code tasks. Production startup requires the dedicated
sandbox control key, egress proxy, browser-origin allowlist, and exact
`QASEY_IMAGE_DIGEST` documented in
[configuration.md](./configuration.md). The outer container runtime must also
permit bubblewrap's unprivileged namespace creation without granting privileged
mode or `SYS_ADMIN`; use the Docker/Kubernetes contract and dedicated-node
guidance in [sandbox-network-boundary.md](./sandbox-network-boundary.md).
Never derive `QASEY_IMAGE_DIGEST` from a mutable tag: resolve the manifest
digest first, launch `qasey-sandbox@sha256:...`, and inject that identical
value into the container.

The distributed profile requires PostgreSQL, Redis, one configured browser login method,
`WORKER_TOKEN`, and a remote sandbox pool when
`QASEY_DEPLOYMENT_MODE=distributed`. API and worker processes must receive the
same `WORKER_TOKEN`; it must be different from `PLATFORM_SERVICE_TOKEN`.

Run exactly one migration job per release digest:

```bash
docker run --rm --env DATABASE_URL='postgresql://...' qasey-service@sha256:<service-digest> \
  sh ci/start.sh migrate
```

Deploy sandbox replicas only from the sandbox digest bound to the same release
manifest as the service digest. Never substitute one image for the other or
copy sandbox tools into an API/Worker workload.

Current post-baseline migrations are expand-only. Destructive contract changes
must be shipped in a later release after every N-1 replica has drained; CI
rejects drop, rename, type-change, and newly-required-column DDL in the rolling
deployment phase.

For a single-container community deployment, set
`QASEY_DEPLOYMENT_MODE=standalone`. It uses one `DATABASE_URL` for application
and observability data, runs workflows in the API process, and does not require
Redis, a worker token, or a sandbox pool. PostgreSQL remains mandatory in
production. Single-tenant deployments enable password login and
self-registration by default; complete Google OIDC can be configured in
addition, and either password feature can be explicitly disabled. Code
authoring is unavailable until a sandbox and E2E
repository configuration are intentionally added.

## Render Blueprint + Supabase

The root `render.yaml` creates a hardened standalone web service from the public
Dockerfile. In Render, create a Blueprint from the public repository. Provide:

- `DATABASE_URL`: Supabase direct or session-mode connection string.
- `QASEY_PUBLIC_BASE_URL`: the final `https://…onrender.com` origin.
- `OPENAI_API_KEY` and, when needed, `PLATFORM_BOOTSTRAP_ADMIN_EMAILS`.
- Optional Google OAuth client ID, client secret, and a 32-character-or-longer
  `GOOGLE_COOKIE_PASSWORD`. Register
  `<QASEY_PUBLIC_BASE_URL>/auth/google/callback` as an authorized redirect URI.

Single-tenant password login and public self-registration are enabled by
default. For an invite-only or administrator-provisioned deployment, set
`QASEY_PASSWORD_REGISTRATION_ENABLED=false`; set
`QASEY_PASSWORD_AUTH_ENABLED=false` only when complete Google OIDC is configured.
This community build does not ship Studio Editor and disables MCP
Preview, code execution, required MCP services, and Datadog by default. Database
migrations run idempotently when the container starts.

## Connection choice

For this long-running Node service, prefer a direct Supabase connection when
IPv6 is available. Otherwise use Supavisor session mode. Transaction mode is
intended for serverless or short-lived connections and does not support
prepared statements, so it is not the default Qasey deployment path.
