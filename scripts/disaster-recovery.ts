import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse as parsePath, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  GetBucketVersioningCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Client, type ClientConfig, type QueryResultRow } from "pg";
import { z } from "zod";
import { artifactOwnerSegment } from "../packages/e2e/src/artifacts.ts";

export const DR_RPO_TARGET_MS = 15 * 60_000;
export const DR_RTO_TARGET_MS = 4 * 60 * 60_000;
export const RESTORE_CONFIRMATION = "YES_I_UNDERSTAND_THIS_RESTORES_DATA";

const REQUIRED_TABLES = [
  "_prisma_migrations",
  "agent_application_runs",
  "agent_application_run_events",
  "mastra_workflow_snapshot",
  "platform_channel_deliveries",
  "platform_roles",
  "platform_role_permissions",
  "platform_subject_roles",
  "platform_audit_log",
  "platform_api_tokens",
  "platform_external_connections",
  "platform_organizations",
  "platform_users",
  "platform_password_credentials",
  "platform_user_identities",
  "platform_organization_memberships",
  "platform_organization_invitations",
  "platform_organization_domains",
  "platform_browser_sessions",
  "platform_slack_app_installations",
  "platform_trigger_bindings",
  "platform_workflow_failure_inbox",
  "platform_workflow_effect_receipts",
  "qasey_sandbox_leases",
  "qasey_mcp_oauth_credentials",
] as const;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const ArtifactEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.iso.datetime(),
  recoveryPointAt: z.iso.datetime(),
  versioningEnabled: z.literal(true),
  backupMode: z.enum(["object-lock", "provider-backup", "versioned-replication"]),
  replicationStatus: z.enum(["enabled", "provider-managed"]),
  retentionDays: z.number().int().min(30),
  objectCount: z.number().int().nonnegative(),
  inventoryDigest: z.string().regex(SHA256),
}).strict();

const BackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  drillId: z.string().regex(SAFE_IDENTIFIER),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  rpoTargetMs: z.literal(DR_RPO_TARGET_MS),
  rtoTargetMs: z.literal(DR_RTO_TARGET_MS),
  database: z.object({
    archive: z.string().regex(SAFE_IDENTIFIER),
    format: z.literal("postgres-custom"),
    sha256: z.string().regex(SHA256),
    bytes: z.number().int().positive(),
    recoveryPointAt: z.iso.datetime(),
    pgDumpVersion: z.string().min(1).max(120),
    sourceServerMajor: z.number().int().positive(),
    appliedMigrationCount: z.number().int().nonnegative(),
  }).strict(),
  artifacts: z.object({
    evidence: z.string().regex(SAFE_IDENTIFIER),
    sha256: z.string().regex(SHA256),
    recoveryPointAt: z.iso.datetime(),
    objectCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type ArtifactBackupEvidence = z.infer<typeof ArtifactEvidenceSchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface DatabaseConnection {
  database: string;
  connectionString: string;
  childEnv: NodeJS.ProcessEnv;
  clientConfig: ClientConfig;
  safeIdentity: string;
}

export interface CommandSpec {
  command: "pg_dump" | "pg_restore" | "psql";
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

export interface ArtifactReference {
  applicationId: string;
  tenantId: string;
  runId: string;
  uri: string;
  sha256: string;
  contentType: string;
}

export interface ArtifactObjectMetadata {
  sha256?: string;
  objectSha256?: string;
  contentType?: string;
  versionId?: string;
  encryption?: string;
  applicationId?: string;
  tenantId?: string;
  runId?: string;
}

export interface ArtifactProbe {
  assertVersioningEnabled(): Promise<void>;
  head(key: string): Promise<ArtifactObjectMetadata>;
}

export interface RestoreSnapshot {
  tables: string[];
  failedMigrationCount: number;
  appliedMigrationCount: number;
  tableCounts: Record<string, number>;
  workflowSnapshotCount: number;
  invariantViolations: Record<string, number>;
  credentialRowsChecked: number;
  artifacts: ArtifactReference[];
}

export class DisasterRecoveryError extends Error {
  constructor(
    readonly code:
      | "ARGUMENT_INVALID"
      | "ARTIFACT_EVIDENCE_INVALID"
      | "ARTIFACT_INTEGRITY_FAILED"
      | "BACKUP_FAILED"
      | "DEPENDENCY_MISSING"
      | "MANIFEST_INVALID"
      | "RESTORE_FAILED"
      | "RESTORE_TARGET_NOT_EMPTY"
      | "RESTORE_TARGET_NOT_CONFIRMED"
      | "RPO_EXCEEDED"
      | "RTO_EXCEEDED"
      | "SCHEMA_INTEGRITY_FAILED"
      | "TOOL_VERSION_INCOMPATIBLE",
    message: string,
  ) {
    super(message);
    this.name = "DisasterRecoveryError";
  }
}

export function parseDatabaseConnection(raw: string | undefined, role: "source" | "target"): DatabaseConnection {
  if (!raw) throw new DisasterRecoveryError("ARGUMENT_INVALID", `The ${role} database environment variable is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", `The ${role} database URL is invalid`);
  }
  if (!(["postgres:", "postgresql:"] as string[]).includes(url.protocol) || !url.hostname || !url.username) {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", `The ${role} database URL must be an authenticated PostgreSQL URL`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database || database.includes("/")) {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", `The ${role} database URL must name one explicit database`);
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", `The ${role} database port is invalid`);
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode") ?? undefined;
  if (sslmode && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", `The ${role} database sslmode is unsupported`);
  }
  const childEnv = minimalChildEnvironment({
    PGHOST: url.hostname,
    PGPORT: String(port),
    PGDATABASE: database,
    PGUSER: user,
    ...(password ? { PGPASSWORD: password } : {}),
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
    PGAPPNAME: `qasey-dr-${role}`,
    PGCONNECT_TIMEOUT: "15",
  });
  const ssl = sslmode === "disable" || !sslmode
    ? undefined
    : { rejectUnauthorized: sslmode === "verify-ca" || sslmode === "verify-full" };
  return {
    database,
    connectionString: raw,
    childEnv,
    clientConfig: {
      host: url.hostname,
      port,
      user,
      ...(password ? { password } : {}),
      database,
      ...(ssl ? { ssl } : {}),
      application_name: `qasey-dr-${role}`,
      connectionTimeoutMillis: 15_000,
    },
    safeIdentity: createHash("sha256").update(`${url.hostname}\0${port}\0${database}`).digest("hex"),
  };
}

export function buildBackupCommand(connection: DatabaseConnection, dumpFile: string): CommandSpec {
  return {
    command: "pg_dump",
    args: [
      "--format=custom",
      `--file=${dumpFile}`,
      `--dbname=${connection.database}`,
      "--no-owner",
      "--no-privileges",
      "--serializable-deferrable",
    ],
    env: connection.childEnv,
  };
}

export function buildRestoreCommand(connection: DatabaseConnection, dumpFile: string): CommandSpec {
  return {
    command: "pg_restore",
    args: [
      `--dbname=${connection.database}`,
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      dumpFile,
    ],
    env: connection.childEnv,
  };
}

export function assertRestoreTarget(input: {
  target: DatabaseConnection;
  confirmation: string | undefined;
  allowRestore: string | undefined;
  source?: DatabaseConnection;
}): void {
  if (input.confirmation !== `RESTORE:${input.target.database}` || input.allowRestore !== RESTORE_CONFIRMATION) {
    throw new DisasterRecoveryError(
      "RESTORE_TARGET_NOT_CONFIRMED",
      "Restore requires the explicit database-name confirmation and restore environment guard",
    );
  }
  if (input.source?.safeIdentity === input.target.safeIdentity) {
    throw new DisasterRecoveryError("RESTORE_TARGET_NOT_CONFIRMED", "Source and restore target must be different databases");
  }
}

export function assertRestoreSnapshot(snapshot: RestoreSnapshot, expectedAppliedMigrationCount?: number): void {
  const missing = REQUIRED_TABLES.filter(table => !snapshot.tables.includes(table));
  const violations = Object.entries(snapshot.invariantViolations).filter(([, count]) => count !== 0);
  const migrationMismatch = expectedAppliedMigrationCount !== undefined
    && snapshot.appliedMigrationCount !== expectedAppliedMigrationCount;
  if (missing.length > 0 || snapshot.failedMigrationCount !== 0 || migrationMismatch || violations.length > 0) {
    const checks = [
      ...(missing.length ? [`missing tables: ${missing.join(",")}`] : []),
      ...(snapshot.failedMigrationCount ? [`failed migrations: ${snapshot.failedMigrationCount}`] : []),
      ...(migrationMismatch
        ? [`applied migrations: expected ${expectedAppliedMigrationCount}, restored ${snapshot.appliedMigrationCount}`]
        : []),
      ...violations.map(([name, count]) => `${name}: ${count}`),
    ];
    throw new DisasterRecoveryError("SCHEMA_INTEGRITY_FAILED", `Restore consistency checks failed (${checks.join("; ")})`);
  }
}

export async function verifyArtifactReferences(
  references: readonly ArtifactReference[],
  probe: ArtifactProbe,
): Promise<void> {
  await probe.assertVersioningEnabled();
  for (const reference of references) {
    if (!SHA256.test(reference.sha256) || !reference.contentType.trim()) {
      throw new DisasterRecoveryError("ARTIFACT_INTEGRITY_FAILED", "Artifact reference metadata is incomplete");
    }
    const key = artifactKey(reference.uri);
    const application = artifactOwnerSegment(reference.applicationId);
    const tenant = artifactOwnerSegment(reference.tenantId);
    const legacyApplication = safeSegment(reference.applicationId);
    const legacyTenant = safeSegment(reference.tenantId);
    const run = safeSegment(reference.runId);
    const ownerScoped = key.includes(`/${application}/${tenant}/${run}/`)
      || key.includes(`/${legacyApplication}/${legacyTenant}/${run}/`);
    if (!run || !ownerScoped) {
      throw new DisasterRecoveryError("ARTIFACT_INTEGRITY_FAILED", "Artifact reference is outside its database owner scope");
    }
    const metadata = await probe.head(key);
    if (
      metadata.sha256 !== reference.sha256
      || metadata.objectSha256 !== reference.sha256
      || metadata.contentType !== reference.contentType
      || !metadata.versionId
      || metadata.versionId === "null"
      || !["AES256", "aws:kms"].includes(metadata.encryption ?? "")
      || metadata.applicationId !== reference.applicationId
      || metadata.tenantId !== reference.tenantId
      || metadata.runId !== reference.runId
    ) {
      throw new DisasterRecoveryError("ARTIFACT_INTEGRITY_FAILED", "Restored artifact metadata or version is inconsistent");
    }
  }
}

export function assertRecoveryPoint(input: {
  manifest: BackupManifest;
  artifactEvidence: ArtifactBackupEvidence;
  incidentAt: string;
}): void {
  const incidentAt = requiredTimestamp(input.incidentAt, "incident time");
  const databasePoint = Date.parse(input.manifest.database.recoveryPointAt);
  const artifactPoint = Date.parse(input.artifactEvidence.recoveryPointAt);
  if (databasePoint > incidentAt || artifactPoint > incidentAt) {
    throw new DisasterRecoveryError("RPO_EXCEEDED", "Recovery points must not be newer than the simulated incident");
  }
  if (incidentAt - databasePoint > DR_RPO_TARGET_MS || incidentAt - artifactPoint > DR_RPO_TARGET_MS) {
    throw new DisasterRecoveryError("RPO_EXCEEDED", "Database or artifact recovery point exceeded the 15 minute RPO");
  }
}

export function assertRecoveryDuration(drillStartedAt: string, completedAt: string): number {
  const started = requiredTimestamp(drillStartedAt, "drill start");
  const completed = requiredTimestamp(completedAt, "drill completion");
  const durationMs = completed - started;
  if (durationMs < 0) {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", "Drill completion cannot be before the drill start");
  }
  if (durationMs > DR_RTO_TARGET_MS) {
    throw new DisasterRecoveryError("RTO_EXCEEDED", "Restore drill exceeded the four hour RTO");
  }
  return durationMs;
}

export async function collectRestoreSnapshot(client: Client): Promise<RestoreSnapshot> {
  const tables = await queryRows<{ table_name: string }>(client,
    "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name");
  const tableNames = tables.map(row => row.table_name);
  const missing = REQUIRED_TABLES.filter(table => !tableNames.includes(table));
  if (missing.length > 0) {
    return {
      tables: tableNames,
      failedMigrationCount: 0,
      appliedMigrationCount: 0,
      tableCounts: {},
      workflowSnapshotCount: 0,
      invariantViolations: { missingCriticalTables: missing.length },
      credentialRowsChecked: 0,
      artifacts: [],
    };
  }

  const [migration, counts, invariants, artifacts] = await Promise.all([
    queryOne<Record<string, unknown>>(client, `
      SELECT count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed_migrations,
             count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied_migrations
      FROM _prisma_migrations`),
    queryOne<Record<string, unknown>>(client, `
      SELECT
        (SELECT count(*) FROM agent_application_runs) AS agent_application_runs,
        (SELECT count(*) FROM agent_application_run_events) AS agent_application_run_events,
        (SELECT count(*) FROM mastra_workflow_snapshot) AS workflow_snapshots,
        (SELECT count(*) FROM platform_channel_deliveries) AS channel_deliveries,
        (SELECT count(*) FROM platform_workflow_failure_inbox) AS failure_inbox,
        (SELECT count(*) FROM platform_workflow_effect_receipts) AS effect_receipts`),
    queryOne<Record<string, unknown>>(client, CONSISTENCY_SQL),
    queryRows<Record<string, unknown>>(client, ARTIFACT_SQL),
  ]);

  const tableCounts = {
    agentApplicationRuns: numeric(counts.agent_application_runs),
    agentApplicationRunEvents: numeric(counts.agent_application_run_events),
    channelDeliveries: numeric(counts.channel_deliveries),
    failureInbox: numeric(counts.failure_inbox),
    effectReceipts: numeric(counts.effect_receipts),
  };
  const invariantViolations = Object.fromEntries(
    Object.entries(invariants)
      .filter(([name]) => name !== "credential_rows_checked")
      .map(([name, value]) => [name, numeric(value)]),
  );
  return {
    tables: tableNames,
    failedMigrationCount: numeric(migration.failed_migrations),
    appliedMigrationCount: numeric(migration.applied_migrations),
    tableCounts,
    workflowSnapshotCount: numeric(counts.workflow_snapshots),
    invariantViolations,
    credentialRowsChecked: numeric(invariants.credential_rows_checked),
    artifacts: artifacts.map(row => ({
      applicationId: stringValue(row.application_id),
      tenantId: stringValue(row.tenant_id),
      runId: stringValue(row.run_id),
      uri: stringValue(row.uri),
      sha256: stringValue(row.sha256),
      contentType: stringValue(row.content_type),
    })),
  };
}

const CONSISTENCY_SQL = `
SELECT
  (SELECT count(*) FROM agent_application_run_events event
    LEFT JOIN agent_application_runs run ON run.application_id=event.application_id AND run.tenant_id=event.tenant_id AND run.id=event.run_id
    WHERE run.id IS NULL) AS orphan_run_events,
  (SELECT count(*) FROM platform_workflow_failure_inbox inbox
    LEFT JOIN agent_application_runs run ON run.application_id=inbox.application_id AND run.tenant_id=inbox.tenant_id AND run.id=inbox.run_id
    WHERE run.id IS NULL) AS orphan_failure_inbox,
  (SELECT count(*) FROM platform_workflow_effect_receipts receipt
    LEFT JOIN agent_application_runs run ON run.application_id=receipt.application_id AND run.tenant_id=receipt.tenant_id AND run.id=receipt.run_id
    WHERE run.id IS NULL) AS orphan_effect_receipts,
  (SELECT count(*) FROM agent_application_runs
    WHERE application_id='' OR tenant_id='' OR id=''
      OR payload->>'applicationId' IS DISTINCT FROM application_id
      OR payload->>'tenantId' IS DISTINCT FROM tenant_id) AS run_owner_mismatches,
  (SELECT count(*) FROM (
      SELECT tenant_id FROM agent_application_runs
      UNION ALL SELECT tenant_id FROM agent_application_run_events
      UNION ALL SELECT tenant_id FROM platform_channel_deliveries
      UNION ALL SELECT tenant_id FROM platform_api_tokens
      UNION ALL SELECT tenant_id FROM platform_external_connections
      UNION ALL SELECT tenant_id FROM platform_workflow_failure_inbox
      UNION ALL SELECT tenant_id FROM platform_workflow_effect_receipts
      UNION ALL SELECT tenant_id FROM platform_slack_app_installations
      UNION ALL SELECT tenant_id FROM platform_trigger_bindings
      UNION ALL SELECT tenant_id FROM qasey_sandbox_leases
    ) owned
    LEFT JOIN platform_organizations organization ON organization.id=owned.tenant_id
    WHERE organization.id IS NULL) AS orphan_tenant_owned_rows,
  (SELECT count(*) FROM platform_browser_sessions session
    JOIN platform_organization_memberships membership
      ON membership.organization_id=session.organization_id AND membership.user_id=session.user_id
    WHERE session.revoked_at IS NULL AND session.expires_at > now() AND membership.status <> 'active') AS active_session_membership_mismatches,
  (SELECT count(*) FROM platform_workflow_failure_inbox
    WHERE (status IN ('redriven','exhausted','closed') AND resolved_at IS NULL)
       OR (status IN ('pending','redriving') AND resolved_at IS NOT NULL)
       OR attempts < 0 OR attempts > max_attempts OR revision < 1) AS invalid_failure_inbox_lifecycle,
  (SELECT count(*) FROM platform_workflow_effect_receipts
    WHERE (status='succeeded' AND (completed_at IS NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL))
       OR (status='pending' AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now()))
       OR (status IN ('failed','unknown') AND (lease_token IS NOT NULL OR lease_expires_at IS NOT NULL OR completed_at IS NOT NULL))
       OR attempts < 1 OR revision < 1) AS invalid_effect_receipt_lifecycle,
  (SELECT count(*) FROM agent_application_runs
    WHERE payload ? 'artifacts' AND jsonb_typeof(payload->'artifacts') <> 'array') AS invalid_artifact_arrays,
  ((SELECT count(*) FROM platform_slack_app_installations
      WHERE bot_token_ciphertext='' OR signing_secret_ciphertext='' OR credential_key_id='' OR credential_fingerprint='')
    + (SELECT count(*) FROM platform_external_connections
      WHERE credentials_ciphertext='' OR credential_key_id='' OR credential_fingerprint='')
    + (SELECT count(*) FROM qasey_mcp_oauth_credentials WHERE encrypted_value='')) AS malformed_encrypted_credentials,
  ((SELECT count(*) FROM platform_slack_app_installations)
    + (SELECT count(*) FROM platform_external_connections)
    + (SELECT count(*) FROM qasey_mcp_oauth_credentials)) AS credential_rows_checked`;

const ARTIFACT_SQL = `
SELECT run.application_id,run.tenant_id,run.id AS run_id,
       artifact->>'uri' AS uri,artifact->>'sha256' AS sha256,artifact->>'contentType' AS content_type
FROM agent_application_runs run
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(run.payload->'artifacts')='array' THEN run.payload->'artifacts' ELSE '[]'::jsonb END
) artifact
ORDER BY run.application_id,run.tenant_id,run.id,artifact->>'id'`;

export class S3RestoreArtifactProbe implements ArtifactProbe {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, config: S3ClientConfig) {
    if (!bucket.trim()) throw new DisasterRecoveryError("ARGUMENT_INVALID", "The restore artifact bucket is required");
    this.client = new S3Client(config);
  }

  async assertVersioningEnabled(): Promise<void> {
    const status = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
    if (status.Status !== "Enabled") {
      throw new DisasterRecoveryError("ARTIFACT_INTEGRITY_FAILED", "The restored artifact bucket does not have versioning enabled");
    }
  }

  async head(key: string): Promise<ArtifactObjectMetadata> {
    const result = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ChecksumMode: "ENABLED",
    }));
    return {
      ...(result.Metadata?.sha256 ? { sha256: result.Metadata.sha256 } : {}),
      ...(result.ChecksumSHA256
        ? { objectSha256: Buffer.from(result.ChecksumSHA256, "base64").toString("hex") }
        : {}),
      ...(result.ContentType ? { contentType: result.ContentType } : {}),
      ...(result.VersionId ? { versionId: result.VersionId } : {}),
      ...(result.ServerSideEncryption ? { encryption: result.ServerSideEncryption } : {}),
      ...(result.Metadata?.application ? { applicationId: result.Metadata.application } : {}),
      ...(result.Metadata?.tenant ? { tenantId: result.Metadata.tenant } : {}),
      ...(result.Metadata?.run ? { runId: result.Metadata.run } : {}),
    };
  }

  close(): void { this.client.destroy(); }
}

class SpawnCommandRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandResult> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let outputBytes = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes <= 64 * 1024) stdout += chunk;
      });
      // Drain stderr but deliberately never expose it: libpq errors may contain
      // connection coordinates supplied by the secret-bearing environment.
      child.stderr.resume();
      child.once("error", error => {
        const code = (error as NodeJS.ErrnoException).code;
        rejectRun(new DisasterRecoveryError(
          code === "ENOENT" ? "DEPENDENCY_MISSING" : "BACKUP_FAILED",
          code === "ENOENT" ? `Required tool ${spec.command} is unavailable` : `${spec.command} could not start`,
        ));
      });
      child.once("exit", code => {
        if (code === 0) resolveRun({ stdout: stdout.trim() });
        else rejectRun(new DisasterRecoveryError(
          spec.command === "pg_restore" ? "RESTORE_FAILED" : "BACKUP_FAILED",
          `${spec.command} exited unsuccessfully`,
        ));
      });
    });
  }
}

async function performBackup(options: Record<string, string>, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const drillId = requiredOption(options, "drill-id");
  if (!SAFE_IDENTIFIER.test(drillId)) throw new DisasterRecoveryError("ARGUMENT_INVALID", "drill-id has an invalid format");
  const outputDir = explicitDirectory(requiredOption(options, "output-dir"));
  const artifactEvidenceFile = explicitFile(requiredOption(options, "artifact-evidence"));
  const source = parseDatabaseConnection(env.QASEY_DR_SOURCE_DATABASE_URL, "source");
  const runner = new SpawnCommandRunner();
  const tools = await checkPostgresTools(runner, source.childEnv);
  const startedAt = new Date();
  const artifactEvidence = ArtifactEvidenceSchema.parse(JSON.parse(await readFile(artifactEvidenceFile, "utf8")));

  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const dumpFile = resolve(outputDir, "postgres.dump");
  const evidenceCopy = resolve(outputDir, "artifact-backup-evidence.json");
  await copyFile(artifactEvidenceFile, evidenceCopy, 0x1);
  await chmod(evidenceCopy, 0o600);

  const sourceMetadata = await withDatabase(source, async client => {
    const server = await queryOne<{ server_version_num: string }>(client, "SHOW server_version_num");
    const migrations = await queryOne<{ applied: string }>(client,
      "SELECT count(*) AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL");
    return { serverMajor: Math.floor(Number(server.server_version_num) / 10_000), migrations: numeric(migrations.applied) };
  });
  assertToolCompatibility(tools, sourceMetadata.serverMajor);
  await runner.run(buildBackupCommand(source, dumpFile));
  await chmod(dumpFile, 0o600);

  const [dumpMetadata, dumpSha256, artifactSha256] = await Promise.all([
    stat(dumpFile),
    sha256File(dumpFile),
    sha256File(evidenceCopy),
  ]);
  if (!dumpMetadata.isFile() || dumpMetadata.size === 0) {
    throw new DisasterRecoveryError("BACKUP_FAILED", "pg_dump did not create a non-empty archive");
  }
  const completedAt = new Date();
  validateArtifactEvidenceAge(artifactEvidence, completedAt);
  const manifest = BackupManifestSchema.parse({
    schemaVersion: 1,
    drillId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    rpoTargetMs: DR_RPO_TARGET_MS,
    rtoTargetMs: DR_RTO_TARGET_MS,
    database: {
      archive: "postgres.dump",
      format: "postgres-custom",
      sha256: dumpSha256,
      bytes: dumpMetadata.size,
      recoveryPointAt: startedAt.toISOString(),
      pgDumpVersion: tools.pgDump.raw,
      sourceServerMajor: sourceMetadata.serverMajor,
      appliedMigrationCount: sourceMetadata.migrations,
    },
    artifacts: {
      evidence: "artifact-backup-evidence.json",
      sha256: artifactSha256,
      recoveryPointAt: artifactEvidence.recoveryPointAt,
      objectCount: artifactEvidence.objectCount,
    },
  });
  const manifestFile = resolve(outputDir, "backup-manifest.json");
  await writeExclusiveJson(manifestFile, manifest);
  return { status: "passed", drillId, manifest: manifestFile };
}

async function performRestoreOrVerify(
  command: "restore" | "verify",
  options: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const manifestFile = explicitFile(requiredOption(options, "manifest"));
  const artifactEvidenceFile = explicitFile(requiredOption(options, "artifact-evidence"));
  const evidenceDir = explicitDirectory(requiredOption(options, "evidence-dir"));
  const incidentAt = requiredOption(options, "incident-at");
  const drillStartedAt = requiredOption(options, "drill-started-at");
  const manifest = BackupManifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  const artifactEvidence = ArtifactEvidenceSchema.parse(JSON.parse(await readFile(artifactEvidenceFile, "utf8")));
  const target = parseDatabaseConnection(env.QASEY_DR_TARGET_DATABASE_URL, "target");
  const source = env.QASEY_DR_SOURCE_DATABASE_URL
    ? parseDatabaseConnection(env.QASEY_DR_SOURCE_DATABASE_URL, "source")
    : undefined;
  assertRestoreTarget({
    target,
    confirmation: options["confirm-target"],
    allowRestore: env.QASEY_DR_ALLOW_RESTORE,
    ...(source ? { source } : {}),
  });
  assertRecoveryPoint({ manifest, artifactEvidence, incidentAt });
  if (await sha256File(artifactEvidenceFile) !== manifest.artifacts.sha256) {
    throw new DisasterRecoveryError("ARTIFACT_EVIDENCE_INVALID", "Artifact evidence checksum does not match the backup manifest");
  }

  await mkdir(evidenceDir, { recursive: false, mode: 0o700 });
  const startedAt = new Date(requiredTimestamp(drillStartedAt, "drill start"));
  let stage = "dependencies";
  try {
    assertRecoveryDuration(startedAt.toISOString(), new Date().toISOString());
    const runner = new SpawnCommandRunner();
    const tools = await checkPostgresTools(runner, target.childEnv);
    if (tools.pgRestore.major !== parsePostgresMajor(manifest.database.pgDumpVersion)) {
      throw new DisasterRecoveryError("TOOL_VERSION_INCOMPATIBLE", "pg_restore major must match the pg_dump archive major");
    }
    const targetMajor = await withDatabase(target, async client => {
      const server = await queryOne<{ server_version_num: string }>(client, "SHOW server_version_num");
      return Math.floor(Number(server.server_version_num) / 10_000);
    });
    if (targetMajor < manifest.database.sourceServerMajor) {
      throw new DisasterRecoveryError("TOOL_VERSION_INCOMPATIBLE", "Restore target PostgreSQL is older than the backup source");
    }

    if (command === "restore") {
      stage = "target-emptiness";
      const tableCount = await withDatabase(target, async client => {
        const row = await queryOne<{ count: string }>(client,
          "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'");
        return numeric(row.count);
      });
      if (tableCount !== 0) {
        throw new DisasterRecoveryError("RESTORE_TARGET_NOT_EMPTY", "Restore target schema must be empty");
      }
      stage = "archive-integrity";
      const archive = resolve(dirname(manifestFile), manifest.database.archive);
      if (await sha256File(archive) !== manifest.database.sha256) {
        throw new DisasterRecoveryError("MANIFEST_INVALID", "PostgreSQL archive checksum does not match the manifest");
      }
      stage = "postgres-restore";
      await runner.run(buildRestoreCommand(target, archive));
    }

    stage = "database-consistency";
    const snapshot = await withDatabase(target, collectRestoreSnapshot);
    assertRestoreSnapshot(snapshot, manifest.database.appliedMigrationCount);
    stage = "artifact-consistency";
    const probe = createS3Probe(env);
    try {
      await verifyArtifactReferences(snapshot.artifacts, probe);
    } finally {
      probe.close();
    }
    const completedAt = new Date();
    const durationMs = assertRecoveryDuration(startedAt.toISOString(), completedAt.toISOString());
    const evidence = {
      schemaVersion: 1,
      drillId: manifest.drillId,
      status: "passed",
      mode: command,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      incidentAt: new Date(requiredTimestamp(incidentAt, "incident time")).toISOString(),
      rpoTargetMs: DR_RPO_TARGET_MS,
      rtoTargetMs: DR_RTO_TARGET_MS,
      database: {
        archiveSha256: manifest.database.sha256,
        recoveryPointAt: manifest.database.recoveryPointAt,
        sourceServerMajor: manifest.database.sourceServerMajor,
        targetServerMajor: targetMajor,
        pgRestoreVersion: tools.pgRestore.raw,
        appliedMigrationCount: snapshot.appliedMigrationCount,
        tableCounts: snapshot.tableCounts,
        workflowSnapshotCount: snapshot.workflowSnapshotCount,
        credentialRowsStructurallyChecked: snapshot.credentialRowsChecked,
      },
      artifacts: {
        referencesChecked: snapshot.artifacts.length,
        backupObjectCount: artifactEvidence.objectCount,
        versioningEnabled: artifactEvidence.versioningEnabled,
        recoveryPointAt: artifactEvidence.recoveryPointAt,
      },
      transientState: { redisRestored: false, policy: "recreate-empty-and-redrive-from-postgres" },
      checks: Object.fromEntries(Object.keys(snapshot.invariantViolations).map(name => [name, "passed"])),
    };
    const evidenceFile = resolve(evidenceDir, "restore-evidence.json");
    await writeExclusiveJson(evidenceFile, evidence);
    return { status: "passed", drillId: manifest.drillId, evidence: evidenceFile };
  } catch (error) {
    const failure = error instanceof DisasterRecoveryError ? error : new DisasterRecoveryError("RESTORE_FAILED", "Restore drill failed");
    await writeExclusiveJson(resolve(evidenceDir, "restore-failure.json"), {
      schemaVersion: 1,
      drillId: manifest.drillId,
      status: "failed",
      stage,
      code: failure.code,
      failedAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw failure;
  }
}

function createS3Probe(env: NodeJS.ProcessEnv): S3RestoreArtifactProbe {
  const bucket = env.QASEY_DR_ARTIFACT_BUCKET;
  const region = env.QASEY_DR_ARTIFACT_REGION;
  if (!bucket || !region) {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", "Restore artifact bucket and region environment variables are required");
  }
  return new S3RestoreArtifactProbe(bucket, {
    region,
    ...(env.QASEY_DR_ARTIFACT_ENDPOINT ? { endpoint: env.QASEY_DR_ARTIFACT_ENDPOINT } : {}),
    ...(env.QASEY_DR_ARTIFACT_FORCE_PATH_STYLE === "true" ? { forcePathStyle: true } : {}),
  });
}

async function checkPostgresTools(runner: CommandRunner, env: NodeJS.ProcessEnv): Promise<{
  pgDump: ToolVersion;
  pgRestore: ToolVersion;
  psql: ToolVersion;
}> {
  const version = async (command: CommandSpec["command"]): Promise<ToolVersion> => {
    const result = await runner.run({ command, args: ["--version"], env });
    return { raw: result.stdout, major: parsePostgresMajor(result.stdout) };
  };
  const [pgDump, pgRestore, psql] = await Promise.all([version("pg_dump"), version("pg_restore"), version("psql")]);
  if (pgDump.major !== pgRestore.major || pgDump.major !== psql.major) {
    throw new DisasterRecoveryError("TOOL_VERSION_INCOMPATIBLE", "PostgreSQL client tools must have the same major version");
  }
  return { pgDump, pgRestore, psql };
}

interface ToolVersion { raw: string; major: number }

function assertToolCompatibility(tools: { pgDump: ToolVersion }, serverMajor: number): void {
  if (tools.pgDump.major < serverMajor) {
    throw new DisasterRecoveryError("TOOL_VERSION_INCOMPATIBLE", "pg_dump is older than the source PostgreSQL server");
  }
}

export function parsePostgresMajor(value: string): number {
  const match = value.match(/(?:PostgreSQL\)?\s+)(\d+)(?:\.|\b)/u);
  const major = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(major) || major < 10) {
    throw new DisasterRecoveryError("TOOL_VERSION_INCOMPATIBLE", "Unable to determine PostgreSQL tool major version");
  }
  return major;
}

async function withDatabase<T>(connection: DatabaseConnection, operation: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(connection.clientConfig);
  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    if (error instanceof DisasterRecoveryError) throw error;
    throw new DisasterRecoveryError("SCHEMA_INTEGRITY_FAILED", "PostgreSQL validation query failed");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function queryRows<T extends QueryResultRow>(client: Client, sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

async function queryOne<T extends QueryResultRow>(client: Client, sql: string): Promise<T> {
  const row = (await queryRows<T>(client, sql))[0];
  if (!row) throw new DisasterRecoveryError("SCHEMA_INTEGRITY_FAILED", "A PostgreSQL validation query returned no result");
  return row;
}

function minimalChildEnvironment(postgres: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries([
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SYSTEMROOT", "WINDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  return { ...inherited, ...postgres };
}

function explicitDirectory(value: string): string {
  if (!isAbsolute(value)) throw new DisasterRecoveryError("ARGUMENT_INVALID", "Evidence and backup directories must be absolute");
  const target = resolve(value);
  if (target === parsePath(target).root) throw new DisasterRecoveryError("ARGUMENT_INVALID", "A filesystem root cannot be a drill directory");
  return target;
}

function explicitFile(value: string): string {
  if (!isAbsolute(value)) throw new DisasterRecoveryError("ARGUMENT_INVALID", "Drill input files must use absolute paths");
  return resolve(value);
}

function validateArtifactEvidenceAge(evidence: ArtifactBackupEvidence, backupCompletedAt: Date): void {
  const point = Date.parse(evidence.recoveryPointAt);
  if (point > backupCompletedAt.getTime() || backupCompletedAt.getTime() - point > DR_RPO_TARGET_MS) {
    throw new DisasterRecoveryError("ARTIFACT_EVIDENCE_INVALID", "Artifact backup evidence does not meet the 15 minute RPO");
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function artifactKey(uri: string): string {
  if (!uri.startsWith("qasey-artifact:")) {
    throw new DisasterRecoveryError("ARTIFACT_INTEGRITY_FAILED", "Distributed restore found a non-shared artifact URI");
  }
  try {
    const key = decodeURIComponent(uri.slice("qasey-artifact:".length));
    if (!key || key.startsWith("/") || key.includes("../")) throw new Error("invalid key");
    return key;
  } catch {
    throw new DisasterRecoveryError("ARTIFACT_INTEGRITY_FAILED", "Artifact URI is malformed");
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/^\.+$/u, "-").slice(0, 160);
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DisasterRecoveryError("SCHEMA_INTEGRITY_FAILED", "A consistency count was invalid");
  }
  return parsed;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function requiredTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new DisasterRecoveryError("ARGUMENT_INVALID", `${label} must be an ISO timestamp`);
  return parsed;
}

function requiredOption(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new DisasterRecoveryError("ARGUMENT_INVALID", `--${key} is required`);
  return value;
}

export function parseOptions(argv: string[]): { command: "backup" | "restore" | "verify"; options: Record<string, string> } {
  const [rawCommand, ...forwardedArgs] = argv;
  if (!(["backup", "restore", "verify"] as string[]).includes(rawCommand ?? "")) {
    throw new DisasterRecoveryError("ARGUMENT_INVALID", "Command must be backup, restore, or verify");
  }
  const args = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new DisasterRecoveryError("ARGUMENT_INVALID", "Every drill option must be a --name value pair");
    }
    const key = name.slice(2);
    if (options[key] !== undefined) throw new DisasterRecoveryError("ARGUMENT_INVALID", `--${key} was provided more than once`);
    options[key] = value;
  }
  return { command: rawCommand as "backup" | "restore" | "verify", options };
}

async function main(): Promise<void> {
  try {
    const { command, options } = parseOptions(process.argv.slice(2));
    const result = command === "backup"
      ? await performBackup(options, process.env)
      : await performRestoreOrVerify(command, options, process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = error instanceof DisasterRecoveryError
      ? error
      : error instanceof z.ZodError
        ? new DisasterRecoveryError("MANIFEST_INVALID", "Drill JSON evidence failed schema validation")
        : new DisasterRecoveryError("RESTORE_FAILED", "Disaster recovery command failed");
    process.stderr.write(`${JSON.stringify({ status: "failed", code: failure.code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
