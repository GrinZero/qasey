# Disaster recovery and restore drill

This runbook defines the production restore contract for Qasey. It is designed
for an isolated recovery account or project; the commands must never target a
live production database or artifact bucket.

## Objectives and state ownership

- **RPO: 15 minutes.** The PostgreSQL recovery point and the artifact recovery
  point must both be no more than 15 minutes before the simulated incident.
- **RTO: 4 hours.** Target creation, restore, integrity verification, application
  canaries, and the operator decision must finish within four hours.
- PostgreSQL is authoritative for application runs, encrypted credentials,
  Mastra workflow snapshots, channel delivery records, the failure inbox, and
  side-effect receipts. Managed PostgreSQL PITR/backup policy is the production
  mechanism; `pg_dump` is the portable drill and export mechanism.
- `QASEY_DR_SOURCE_DATABASE_URL` must identify the authoritative
  `DATABASE_URL`, not a separate observability database. In a distributed
  topology, `OBSERVABILITY_DATABASE_URL` has its own retention/backup policy;
  restore it separately when audit or compliance retention requires it. Loss
  of telemetry must not be treated as successful compliance recovery, but it
  does not replace restoring the authoritative application database.
- S3-compatible storage is authoritative for artifact bytes. The storage owner
  must enable bucket versioning plus object lock, provider backup, or versioned
  replication. Database backup alone is not an artifact backup.
- **Redis is transient.** Redis Streams, cache keys, leases, and short-lived
  dedupe state are recreated empty. They are not restored. Recoverable work is
  reconciled from PostgreSQL snapshots, heartbeats, the failure inbox, and
  effect receipts. A recovery Redis namespace must not reuse stale production
  keys.

These targets require managed PostgreSQL backup/PITR and object-storage recovery
points at least every 15 minutes. A periodic `pg_dump` slower than that cadence
does not by itself satisfy the production RPO.

## Safety properties

The drill commands:

- accept database URLs only from secret-bearing environment variables;
- pass libpq credentials only through a minimal child environment;
- never print the URL, password, child stderr, or artifact endpoint;
- require absolute input and evidence paths;
- write new `0700` directories and `0600`, non-overwriting evidence files;
- restore only to an existing, empty target schema;
- never use `pg_restore --clean`, `--create`, or database drop commands;
- require both `RESTORE:<database-name>` and a separate environment guard;
- fail non-zero on missing tools, incompatible PostgreSQL versions, checksum
  mismatch, RPO/RTO breach, or any consistency failure.

Use a dedicated least-privilege backup role and a separate restore owner. Do not
grant either role access to unrelated databases. Inject secrets from the
deployment secret manager; do not put them in shell history, `.env`, evidence,
or ticket comments.

## Prerequisites

1. Node.js 24 and repository dependencies are installed.
2. `pg_dump`, `pg_restore`, and `psql` are installed at the same major version.
   `pg_dump` must be at least as new as the source server; `pg_restore` must
   match the archive's `pg_dump` major.
3. The artifact platform has restored the selected bucket recovery point into
   an isolated versioned bucket. AWS-compatible credentials are provided by the
   workload identity or standard AWS environment variables.
4. Create a new empty PostgreSQL database. Do not point the command at a shared
   schema or a database where application tables already exist.
5. Allocate a new absolute evidence directory for every command. Existing
   output is deliberately never overwritten.

## Artifact backup evidence

Before the database export, the object-storage backup job must write a redacted
JSON control record. It contains policy and inventory evidence, not bucket
names, endpoints, object keys, credentials, or tenant content:

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-08-26T10:00:00.000Z",
  "recoveryPointAt": "2026-08-26T09:59:00.000Z",
  "versioningEnabled": true,
  "backupMode": "versioned-replication",
  "replicationStatus": "enabled",
  "retentionDays": 30,
  "objectCount": 1250,
  "inventoryDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The storage platform owns lifecycle retention, legal hold/object lock where
required, cross-region replication, and inventory generation. Qasey's drill
copies this record as `artifact-backup-evidence.json` and binds its SHA-256 to
the database backup manifest. During restore, Qasey also HEAD-checks every
artifact referenced by a restored run for owner scope, checksum, content type,
server-side encryption, and a non-null object version.

## Create the portable backup

Choose a new directory. The script refuses an existing path.

```bash
export QASEY_DR_SOURCE_DATABASE_URL="$(secret-manager read qasey/dr-source-database-url)"
pnpm dr:backup -- \
  --drill-id drill-2026-08-26 \
  --output-dir /absolute/recovery/drill-2026-08-26/backup \
  --artifact-evidence /absolute/provider-evidence/artifact-evidence.json
unset QASEY_DR_SOURCE_DATABASE_URL
```

Expected files:

- `postgres.dump`: custom-format, owner/ACL-independent PostgreSQL archive;
- `artifact-backup-evidence.json`: immutable copy of provider evidence;
- `backup-manifest.json`: archive sizes, SHA-256 values, tool/server major,
  migration count, conservative database recovery point, RPO/RTO, and
  timestamps. It contains no connection data.

Copy this bundle to the approved encrypted evidence store. The manifest is not
a substitute for the managed PostgreSQL backup catalog or S3 version history.

## Restore into isolation

The simulated incident time must be after both selected recovery points and no
more than 15 minutes after either one. Record the UTC drill start before
provisioning the empty database or starting the S3 restore; this makes the RTO
measurement cover infrastructure recovery rather than only the script runtime.
Restore the S3 recovery point first, then run:

```bash
export QASEY_DR_TARGET_DATABASE_URL="$(secret-manager read qasey/dr-target-database-url)"
export QASEY_DR_ALLOW_RESTORE=YES_I_UNDERSTAND_THIS_RESTORES_DATA
export QASEY_DR_ARTIFACT_BUCKET="$(secret-manager read qasey/dr-target-artifact-bucket)"
export QASEY_DR_ARTIFACT_REGION="$(secret-manager read qasey/dr-target-artifact-region)"

pnpm dr:restore -- \
  --manifest /absolute/recovery/drill-2026-08-26/backup/backup-manifest.json \
  --artifact-evidence /absolute/recovery/drill-2026-08-26/backup/artifact-backup-evidence.json \
  --evidence-dir /absolute/recovery/drill-2026-08-26/restore-evidence \
  --incident-at 2026-08-26T10:10:00.000Z \
  --drill-started-at 2026-08-26T10:12:00.000Z \
  --confirm-target RESTORE:qasey_restore

unset QASEY_DR_TARGET_DATABASE_URL QASEY_DR_ALLOW_RESTORE
unset QASEY_DR_ARTIFACT_BUCKET QASEY_DR_ARTIFACT_REGION
```

For an S3-compatible service, set `QASEY_DR_ARTIFACT_ENDPOINT`; set
`QASEY_DR_ARTIFACT_FORCE_PATH_STYLE=true` only when the provider requires it.
The endpoint is never copied into evidence.

`pnpm dr:verify` accepts the same arguments and confirmations but skips
`pg_restore`. Use it after infrastructure changes or application canaries to
repeat all database and artifact checks without changing state.

## Automated consistency checks

The restore fails unless all of these pass:

1. Prisma migration history has no unfinished, non-rolled-back migration and
   its applied count matches the backup manifest.
2. All Prisma application tables, including organization invitations, and
   `mastra_workflow_snapshot` exist.
3. Run events, failure-inbox items, and effect receipts have an owner-matched
   parent run; run payload owners match their relational owner columns; every
   workload, API-token, connection, Slack, trigger, and sandbox tenant scope
   refers to a restored organization. System-scoped RBAC/audit rows are kept
   separate because they can use a non-organization service scope.
4. An unrevoked, unexpired browser session belongs to an active organization
   membership.
5. Terminal failure-inbox rows are resolved, and effect-receipt status agrees
   with lease/completion fields. These receipts are what prevent a redrive from
   repeating an already completed external write.
6. Encrypted Slack, external-connection, and MCP credential records retain
   non-empty ciphertext, key ID/fingerprint metadata where applicable.
7. Every restored artifact reference uses shared storage, remains within its
   versioned, injectively encoded application/tenant/run prefix and exact owner
   metadata (legacy slug prefixes remain read-only compatible), and matches both the
   restored object's checksum and checksum metadata, content type, encryption
   mode, and object version.

Structural ciphertext checks cannot prove that the secret manager restored the
correct encryption key. Before declaring recovery, start one isolated API
replica with the restored key material and record redacted canaries that decrypt
one record for every populated credential family without calling the external
provider. Then perform one read-only authenticated login/session check and one
workflow snapshot resume that uses a non-side-effecting fixture.

## Evidence and decision

On success, archive `restore-evidence.json` with:

- backup manifest and provider artifact evidence;
- exact release image digest and infrastructure revision used for the drill;
- database and artifact check counts;
- redacted credential-decryption, login, and workflow-resume canaries;
- start/end timestamps and incident timestamp;
- operator, reviewer, deviations, and go/no-go decision.

On failure, the command exits non-zero and writes `restore-failure.json` with a
stage and stable error code only. Preserve the incomplete target and provider
logs under restricted access for investigation; never paste raw database or S3
errors into the public evidence bundle. Create a corrective action with owner
and due date, then repeat the drill from a new empty target.

The drill passes only when both RPO and RTO are met, automated integrity checks
pass, credential and workflow canaries pass, and an independent reviewer signs
the evidence. Tooling in the repository is not evidence that a production-like
drill has actually occurred.
