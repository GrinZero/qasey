# Configuration reference

Qasey is configured through process environment variables. The authoritative
validation and defaults live in [`packages/adapters/src/config.ts`](../packages/adapters/src/config.ts);
this page explains the deployment contract without requiring an operator to
read source code.

## Environment file loading

For local development, copy `.env.example` to `.env`. Qasey accepts only
`development`, `test`, or `production` as `NODE_ENV` and loads files in this
order:

1. `.env`
2. `.env.<NODE_ENV>`
3. `.env.local`
4. `.env.<NODE_ENV>.local`

Later files override earlier files, while variables already supplied by the
process always win. Runtime `.env` files, private keys, MCP catalogues, and E2E
repository catalogues are ignored by both Git and Docker. Production platforms
should inject values from their secret manager instead of mounting env files.

## Core runtime and PostgreSQL

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime validation profile. Production enables mandatory auth, database migrations, and hardened defaults. |
| `QASEY_DEPLOYMENT_MODE` | `standalone` | `standalone` runs workflows in the API process; `distributed` enables Redis and the official Mastra Worker. |
| `QASEY_DEPLOYMENT_ID` | `NODE_ENV` | Stable, portable Redis namespace shared by every replica in one deployment. Required in production. |
| `QASEY_INSTANCE_ID` | none | Unique process/replica identifier for metrics and incident attribution. Required in production; never use it to partition shared state. |
| `QASEY_PUBLIC_BASE_URL` | `http://localhost:4111` | Browser-visible origin used for callbacks and same-origin checks. |
| `DATABASE_URL` | none | PostgreSQL connection for application and Mastra state; required in production. |
| `OBSERVABILITY_DATABASE_URL` | local DuckDB in development; `DATABASE_URL` in standalone production | Optional separate Mastra observability PostgreSQL connection. |
| `QASEY_OBSERVABILITY_DB_PATH` | `.qasey/observability.duckdb` | Development DuckDB path when no observability URL is supplied. |

As an alternative to `DATABASE_URL`, operators may provide `PG_URL`, `PG_PORT`,
`PG_QASEY_USER_NAME`, and `PG_QASEY_PASSWORD` together. The optional database
names default to `qasey` (`PG_QASEY_DATABASE_NAME`) and `qasey_observability`
(`PG_QASEY_OBSERVABILITY_DATABASE_NAME`). A standard `DATABASE_URL` is the
recommended public deployment interface.

## Identity and secrets

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_COOKIE_PASSWORD` | Optional Google OIDC and encrypted short-lived login state. When Google login is enabled all three are required, and the cookie password must be at least 32 characters. Browser sessions use opaque tokens whose hashes are stored in the application database. |
| `GOOGLE_REDIRECT_URI` | Explicit callback URL; normally derived from the public base URL. |
| `GOOGLE_ALLOWED_DOMAINS`, `GOOGLE_HOSTED_DOMAIN` | Optional comma-separated login allowlist and hosted-domain hint. Domains never grant tenant membership. |
| `QASEY_PASSWORD_AUTH_ENABLED` | Enables email/password login for a `single`-tenant installation. It defaults to `true` in every environment, including production; set it to `false` to opt out. Passwords must contain 15–128 characters and are stored as independently salted, versioned scrypt hashes. It defaults to `false` in `multi` mode. |
| `QASEY_PASSWORD_REGISTRATION_ENABLED` | Enables same-origin self-registration when password auth is enabled. It follows the password-auth default, including in production, and can be disabled independently with `false`. It defaults to `false` and cannot be enabled in `multi` mode. |
| `QASEY_TENANCY_MODE`, `QASEY_SINGLE_TENANT_ID` | `single` keeps one explicitly configured tenant and requires an active membership, an exact-email invitation for that tenant, or an explicit bootstrap email. `multi` requires an active membership or one exact invitation; multiple memberships enter an explicit, short-lived organization-selection transaction. |
| `PLATFORM_BOOTSTRAP_ADMIN_EMAILS` | Comma-separated break-glass administrators whose first verified login may bootstrap membership. |
| `PLATFORM_LOCAL_ADMIN_EMAILS` | Development-only comma-separated local password accounts that receive `platform-admin` after registration. Production rejects this setting; use a verified Google bootstrap administrator there. |
| `PLATFORM_SERVICE_TOKEN` | Optional service Bearer identity of at least 32 UTF-8 bytes; keep distinct from all worker, tunnel, webhook, and metrics tokens. |
| `QASEY_DEV_AUTH_TOKEN` | Local script/API Bearer token of at least 32 characters. Development only; production rejects it. |
| `QASEY_CREDENTIAL_ENCRYPTION_KEY`, `QASEY_CREDENTIAL_ACTIVE_KEY_ID` | Active envelope-encryption key and its stable ID for tenant integrations. The key is required in production, must contain at least 32 UTF-8 bytes, and the ID defaults to `default` for backward compatibility. |
| `QASEY_CREDENTIAL_PREVIOUS_KEYS` | Optional JSON object from historical key IDs to decrypt-only keys. IDs and keys are strictly validated; at most 16 distinct generations may be loaded. |
| `MASTRA_ENCRYPTION_KEY`, `MASTRA_ENCRYPTION_ACTIVE_KEY_ID` | Active encryption key and key ID for persisted OAuth MCP credentials. The key must contain at least 32 UTF-8 bytes; the ID defaults to `default` for legacy envelopes. |
| `MASTRA_ENCRYPTION_PREVIOUS_KEYS` | Optional JSON map of decrypt-only OAuth MCP key generations. Startup re-encrypts old rows under the active generation with compare-and-set, and reads also migrate a row lazily. |

Credential rotation uses an expand/flip/rotate/contract sequence that is safe
for rolling deployments. First keep the old key active, add the next key to the
decrypt-only map, and roll every replica so both generations are readable.
Then make the next key active, retain the old key in the decrypt-only map, and
roll every replica again. Tenant external connections are re-encrypted with
`POST /admin/api/connections/:connectionId/rotate`;
managed Slack installations use
`POST /admin/api/triggers/connections/slack/:id/rotate`. Both endpoints require
the current revision and never accept or return credential plaintext. Their
list responses expose the non-secret `credentialKeyId`, so operators can retry
conflicts and verify completion. Remove an old decrypt key only after every
record and every running replica has moved past that key generation.

OAuth MCP storage follows the same expand/flip/contract discipline with its
separate `MASTRA_ENCRYPTION_*` keyring. Deploy the version-aware reader while
the active ID is still `default`, then retain the old material under the
`default` entry when selecting a new active ID. Startup scans OAuth rows in
bounded batches and uses ciphertext compare-and-set to avoid overwriting a
concurrent token refresh. New envelopes bind their namespace and storage key as
authenticated data, so moving ciphertext between users or servers fails
closed. Remove the legacy entry only after every replica starts cleanly and a
database inventory confirms no `v1.` or retired-key envelope remains.

### Membership and invitation rules

Verified and allowed domains are authentication and discovery attributes only;
they never create membership. An organization invitation names one normalized
email address, has an explicit expiry, and can be revoked before acceptance.
Creating the same still-valid invitation again for one organization is
idempotent; invitations for the same email in different organizations remain
distinct and make first-time multi-tenant login fail closed until the
invitation ambiguity is resolved. Existing multiple active memberships are
presented through the explicit organization selector.
Google login accepts an invitation only after Google verifies that exact email
for the internal user. The store selects and consumes the invitation and creates
the active membership in one serializable transaction. Zero, multiple,
expired, revoked, mismatched, or already-consumed candidates fail closed.
Password self-registration is a separate, operator-enabled single-tenant path:
it atomically creates the user, local identity, password credential, and active
membership. A local password does not verify ownership of the email inbox, so
that identity cannot consume email invitations or activate a bootstrap-admin
address. Password auth fails closed in multi-tenant mode.

Membership administration is tenant-scoped. Suspending or removing a member
revokes all of that user's current browser sessions, while leaving memberships
in other organizations unchanged; the user must authenticate again for those
organizations.

## Models and agent limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Public OpenAI API credential used by Qasey and code-authoring sandboxes. |
| `OPENAI_BASE_URL` | OpenAI API | Optional compatible Responses API endpoint. |
| `QASEY_MEMORY_MODEL` | `gpt-5.6-luna` | Model for observational memory. |
| `QASEY_CODE_AGENT_MODEL` | `gpt-5.6-sol` | Model for isolated repository code tasks. |
| `QASEY_CODE_AGENT_MAX_STEPS` | `80` | Maximum model steps per code task (`1..500`). |
| `QASEY_AGENT_TIMEOUT_MS` | `3000000` | End-to-end Agent deadline. |
| `QASEY_INTENT_TIMEOUT_MS` | `60000` | Intent-routing deadline. |
| `QASEY_MAX_REPAIRS` | `2` | Maximum E2E repair attempts (`0..5`). |
| `QASEY_MEMORY_MESSAGE_TOKENS` | `30000` | Recent-message memory budget. |
| `QASEY_MEMORY_OBSERVATION_TOKENS` | `40000` | Observational-memory budget. |
| `QASEY_MEMORY_INPUT_TOKEN_LIMIT` | `120000` | Total memory input ceiling; must exceed the two preceding budgets combined. |
| `QASEY_REQUEST_BODY_MAX_BYTES` | `1048576` | Hard request-body ceiling enforced before authorization, including chunked bodies. |
| `QASEY_STANDARD_TENANT_REQUESTS_PER_MINUTE` / `QASEY_STANDARD_SUBJECT_REQUESTS_PER_MINUTE` | `6000` / `600` | Shared tenant and per-subject request budgets. |
| `QASEY_EXPENSIVE_TENANT_REQUESTS_PER_MINUTE` / `QASEY_EXPENSIVE_SUBJECT_REQUESTS_PER_MINUTE` | `60` / `10` | Additional budgets for Agent, workflow, run creation/re-drive, and Sandbox mutations. |
| `QASEY_EXPENSIVE_TENANT_CONCURRENCY` | `4` | Maximum concurrent expensive requests in one tenant. |
| `QASEY_EXPENSIVE_LEASE_TTL_MS` | `3600000` | Self-healing distributed concurrency lease; keep above the longest accepted request deadline. |

## Distributed runtime and Redis

Distributed production requires a cryptographically random `WORKER_TOKEN` of
at least 32 UTF-8 bytes, `REDIS_HOST`, `REDIS_PORT`,
`REDIS_PASSWORD`, and `REDIS_TLS=true`. `REDIS_USERNAME` and
`REDIS_TLS_SERVERNAME` are optional. API and Worker must share the same
`WORKER_TOKEN`; the container maps it to Mastra's
`MASTRA_WORKER_AUTH_TOKEN`. The Worker exposes private `/healthz`, `/readyz`,
and `/metrics` probes on `QASEY_WORKER_HEALTH_PORT` (default `8081`);
production requires a distinct `QASEY_WORKER_METRICS_TOKEN` of at least 32
bytes for the metrics route. Readiness also requires a child-owned IPC heartbeat
newer than `QASEY_WORKER_HEARTBEAT_TIMEOUT_MS` (default `15000`, accepted range
`3000`–`300000`). `QASEY_USE_REDIS_DURABILITY=true` opts a local or
standalone runtime into Redis-backed delivery for testing.

The same Redis connection owns atomic traffic counters and expensive-request
leases in distributed mode. Identity components are SHA-256 encoded before
they enter Redis keys. Storage failures fail admission with HTTP 503; quota or
concurrency exhaustion returns HTTP 429 with `Retry-After`. Public OAuth and
signed-channel bootstrap traffic receives bounded global/per-route budgets
rather than an unlimited anonymous bypass. Tune defaults only from load-test
evidence, and keep edge/proxy body, connection, and IP limits as an independent
outer boundary.

## Optional integrations

| Integration | Variables or files |
| --- | --- |
| Slack | `SLACK_CHANNEL_MODE`, `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_SOCKET_MODE_APP_TOKEN`, `SLACK_BOT_USER_ID`; `SLACK_BASE_URL` is only for compatible/test endpoints. Managed installations can instead be added in Admin UI. |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_WEBHOOK_TOKEN`, `JIRA_QASEY_ACCOUNT_ID`. |
| GitHub | `GITHUB_TOKEN` accepts a personal access token (PAT); `GITHUB_ORG` is optional. Fine-grained PATs need Contents and Pull requests read/write access to repositories where Qasey publishes Draft PRs. `GITHUB_WEBHOOK_SECRET`, when used, remains a separate webhook signing secret. |
| MCP | In `single` mode, copy `config/mcp.example.json` to ignored `config/mcp.json`; override with `QASEY_MCP_CONFIG_FILE`. In `multi` mode this static file may contain only subject-bound OAuth servers; static `none` and process-environment bearer authentication fail closed. Tenant bearer servers must use an encrypted `provider=mcp` external connection as described below. OAuth token files use `QASEY_MCP_OAUTH_DIR` (default `.qasey/oauth`). |
| E2E repository | Copy `config/e2e-repository.example.json` to ignored `config/e2e-repository.json`; override with `QASEY_E2E_REPOSITORY_CONFIG_FILE`. The Service reads and validates target + Sandbox-reachable test environment + verification once per new run and freezes them into the run/brief/task spec; Sandbox images never contain or mount this file. |
| E2E fixture deployment | The build stamps the checked-out Git commit into an internal build artifact; there is no manually supplied Qasey source-SHA setting. Preflight compares that artifact to the repository base ref before creating state. A verifier leases an isolated organization/user/browser session with a dedicated least-privilege fixture role, injects a temporary Playwright storage-state file, and always requests cleanup. `PLATFORM_SERVICE_TOKEN` is needed only by an external service caller using the Fixture HTTP API, not by Qasey's own Workflow. |

In multi-tenant mode, do not set a process-global `GITHUB_TOKEN`. Store each
PAT as an encrypted `provider=github` external connection instead:

```json
{
  "provider": "github",
  "name": "tenant-github",
  "configuration": {
    "repositoryOwner": "example-org"
  },
  "credentials": {
    "token": "<PAT supplied through the admin credential input>"
  }
}
```

`repositoryOwner` is optional and acts as a selector when a tenant has multiple
GitHub connections. A tenant-wide sandbox credential requires exactly one
active GitHub connection. Tokens remain encrypted at rest and are never
returned by the Admin API.

### Tenant-owned MCP connections

Multi-tenant bearer credentials belong in the encrypted external-connection
store, never in `config/mcp.json`, process environment, or the public
configuration. Create an active connection with `provider=mcp` and this exact
shape:

```json
{
  "name": "tenant-figma",
  "configuration": {
    "serverName": "figma",
    "url": "https://mcp.example.com/mcp",
    "allowedHosts": ["mcp.example.com"],
    "timeoutMs": 60000
  },
  "credentials": {
    "bearerToken": "<secret supplied through the admin credential input>"
  }
}
```

`serverName` must be one of the built-in allowlisted MCP server names. URLs
must use HTTPS and a public multi-label DNS hostname; IP literals, credentials,
fragments, local/private suffixes, and wildcard hosts fail closed. Hosts are
exact, redirects are disabled for tenant-managed Jira requests, and each active
connection in a tenant must have a unique `serverName`. These application
checks do not prevent DNS rebinding, so production must also deny private,
loopback, link-local, and metadata-service egress at the resolver/network
boundary. A tenant connection may not collide with a static OAuth server.
Credential rotation, configuration changes, disable, and revoke increment the
connection revision; Qasey disconnects the old tenant client before creating
one for the new revision.

## Feature flags and observability

The community build deliberately does not ship Mastra Studio Editor because its
published artifact contains separately licensed code without the corresponding
license text. `QASEY_ENABLE_STUDIO_EDITOR=true` and `EDITOR_DATABASE_URL` are
rejected at startup; use the audited Admin UI instead. Studio MCP Preview, Code
Mode, local Code Mode, and Datadog are off by default and use
`QASEY_ENABLE_STUDIO_MCP_PREVIEW`, `QASEY_ENABLE_CODE_MODE`,
`QASEY_ENABLE_LOCAL_CODE_MODE`, and `QASEY_ENABLE_DATADOG` respectively.
Code Mode limits are `QASEY_CODE_MODE_TIMEOUT_MS` (default `180000`) and
`QASEY_CODE_MODE_MEMORY_LIMIT_MB` (default `128`).

Datadog configuration uses `DD_LLMOBS_ML_APP`, `DD_SERVICE` (default `qasey`),
`DD_ENV`, `DD_VERSION`, and `DD_SITE` (default `datadoghq.com`). Agentless mode
requires `DD_LLMOBS_AGENTLESS_ENABLED=true` and `DD_API_KEY`. Model input/output
capture is disabled unless `QASEY_DATADOG_CAPTURE_CONTENT=true`; enabling it is
a separate privacy decision.

## Workspace and sandbox

Local data defaults under `.qasey/` through `QASEY_DATA_ROOT`,
`QASEY_WORKSPACE_DIR`, `QASEY_GIT_CACHE_DIR`, and `QASEY_ARTIFACT_DIR`.
Production code authoring uses `QASEY_SANDBOX_ENDPOINT_TEMPLATE` containing
`{ordinal}`. Pool and lifecycle tuning variables are:

- `QASEY_SANDBOX_REPLICAS` (`2`)
- `QASEY_SANDBOX_MAX_SESSIONS` (`5` in development; exactly `1` in production)
- `QASEY_SANDBOX_IDLE_TTL_MS` (`1800000`)
- `QASEY_SANDBOX_REQUEST_TIMEOUT_MS` (`1800000`)
- `QASEY_SANDBOX_SHUTDOWN_TIMEOUT_MS` (`25000`; keep below the workload termination grace period)
- `QASEY_WORKSPACE_RETENTION_MS` (`604800000`)
- `QASEY_SANDBOX_DESKTOP_ENABLED` (`false`)
- `QASEY_SANDBOX_DESKTOP_DISPLAY` (`99`)
- `QASEY_SANDBOX_DESKTOP_WIDTH` (`1440`)
- `QASEY_SANDBOX_DESKTOP_HEIGHT` (`900`)

The sandbox process itself also accepts `QASEY_SANDBOX_HOST` (`0.0.0.0`),
`QASEY_SANDBOX_PORT` (`4120`), `QASEY_SANDBOX_COMMAND_TIMEOUT_MS` (`1800000`),
and `QASEY_SANDBOX_ISOLATION` (`none` or `bwrap`). The default `none` assumes
the sandbox process already runs inside a dedicated container or VM boundary.
Production also requires `QASEY_IMAGE_DIGEST` in exact lowercase
`sha256:<64 hex>` form. Deployment automation must resolve the immutable
sandbox manifest, start that exact digest, and inject the same digest so every
Code Task result is cryptographically attributable to its execution image.
Production always requires `bwrap`; every Code Task receives a task-only mount
namespace and the interactive browser launches inside a separate session
namespace. Production also rejects `QASEY_SANDBOX_MAX_SESSIONS` values other
than `1`: scale Sandbox pods/replicas for concurrency so a fork, OOM, or disk
pressure event cannot take out another tenant in the same process. The pod or
VM supervisor remains responsible for CPU, memory, PID, and ephemeral-storage
limits; bubblewrap alone is not a resource quota.
The shared-replica computer-use desktop is rejected in production until it is
provisioned as a dedicated per-session container or VM. Use `bwrap` only on
Linux hosts where unprivileged user namespaces are enabled; readiness fails
closed when bubblewrap cannot initialize.

`QASEY_DEV_TUNNEL_ENABLED`, `QASEY_DEV_TUNNEL_BASE_URL`,
`QASEY_DEV_TUNNEL_TOKEN`, and optional `QASEY_DEV_RUNTIME_ID` form an advanced
Slack development bridge between a signed production ingress and a local
runtime. They are not required for normal self-hosting. The tunnel token must
contain at least 32 UTF-8 bytes, remain unique, and production rejects an
enabled tunnel server without it. `JIRA_WEBHOOK_TOKEN`, when configured,
follows the same minimum length.
