import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertRecoveryPoint,
  assertRecoveryDuration,
  assertRestoreSnapshot,
  assertRestoreTarget,
  buildBackupCommand,
  buildRestoreCommand,
  DR_RPO_TARGET_MS,
  DR_RTO_TARGET_MS,
  parseDatabaseConnection,
  parseOptions,
  parsePostgresMajor,
  RESTORE_CONFIRMATION,
  verifyArtifactReferences,
  type ArtifactBackupEvidence,
  type ArtifactProbe,
  type BackupManifest,
  type RestoreSnapshot,
} from "../../scripts/disaster-recovery.ts";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("production disaster recovery drill", () => {
  it("passes PostgreSQL secrets only through a minimal child environment", () => {
    const connectionUrl = new URL("postgresql://db.example.com:5432/qasey_restore?sslmode=require");
    connectionUrl.username = "restore-operator";
    connectionUrl.password = "fixture-password";
    const connection = parseDatabaseConnection(connectionUrl.toString(), "target");
    const dump = buildBackupCommand(connection, "/var/backups/qasey/postgres.dump");
    const restore = buildRestoreCommand(connection, "/var/backups/qasey/postgres.dump");

    expect(dump.args.join(" ")).not.toContain("fixture-password");
    expect(restore.args.join(" ")).not.toContain("fixture-password");
    expect(dump.args.join(" ")).not.toContain("db.example.com");
    expect(dump.args).toContain("--dbname=qasey_restore");
    expect(restore.args).toContain("--dbname=qasey_restore");
    expect(restore.args).not.toContain("--clean");
    expect(restore.args).not.toContain("--create");
    expect(connection.childEnv).toMatchObject({
      PGDATABASE: "qasey_restore",
      PGUSER: "restore-operator",
      PGPASSWORD: "fixture-password",
      PGSSLMODE: "require",
    });
    expect(connection.childEnv.DATABASE_URL).toBeUndefined();
    expect(connection.childEnv.QASEY_DR_TARGET_DATABASE_URL).toBeUndefined();
  });

  it("requires two explicit confirmations and refuses the source database", () => {
    const sourceUrl = new URL("postgresql://source.example.com/qasey");
    sourceUrl.username = "operator";
    sourceUrl.password = "fixture-password";
    const targetUrl = new URL("postgresql://restore.example.com/qasey_restore");
    targetUrl.username = "operator";
    targetUrl.password = "fixture-password";
    const source = parseDatabaseConnection(sourceUrl.toString(), "source");
    const target = parseDatabaseConnection(targetUrl.toString(), "target");

    expect(() => assertRestoreTarget({
      target,
      source,
      confirmation: "RESTORE:qasey_restore",
      allowRestore: RESTORE_CONFIRMATION,
    })).not.toThrow();
    expect(() => assertRestoreTarget({ target, confirmation: "qasey_restore", allowRestore: RESTORE_CONFIRMATION }))
      .toThrow(/explicit database-name confirmation/u);
    expect(() => assertRestoreTarget({
      target: source,
      source,
      confirmation: "RESTORE:qasey",
      allowRestore: RESTORE_CONFIRMATION,
    })).toThrow(/different databases/u);
  });

  it("fails the drill on schema, tenant, inbox, receipt, or migration inconsistency", () => {
    expect(() => assertRestoreSnapshot(validSnapshot(), 4)).not.toThrow();
    expect(() => assertRestoreSnapshot(validSnapshot(), 5)).toThrow(/applied migrations/u);
    expect(() => assertRestoreSnapshot({
      ...validSnapshot(),
      failedMigrationCount: 1,
      invariantViolations: {
        ...validSnapshot().invariantViolations,
        run_owner_mismatches: 2,
        invalid_effect_receipt_lifecycle: 1,
      },
    })).toThrow(/failed migrations.*run_owner_mismatches.*invalid_effect_receipt_lifecycle/u);
    expect(() => assertRestoreSnapshot({ ...validSnapshot(), tables: ["agent_application_runs"] }))
      .toThrow(/missing tables/u);
  });

  it("checks every restored artifact against owner scope, checksum, encryption, and version", async () => {
    const probe: ArtifactProbe = {
      assertVersioningEnabled: vi.fn(async () => undefined),
      head: vi.fn(async () => ({
        sha256: "a".repeat(64),
        objectSha256: "a".repeat(64),
        contentType: "application/json",
        versionId: "version-1",
        encryption: "aws:kms",
        applicationId: "qasey",
        tenantId: "tenant-1",
        runId: "run-1",
      })),
    };
    const reference = {
      applicationId: "qasey",
      tenantId: "tenant-1",
      runId: "run-1",
      uri: `qasey-artifact:${encodeURIComponent("qasey-artifacts/qasey/tenant-1/run-1/report.json")}`,
      sha256: "a".repeat(64),
      contentType: "application/json",
    };

    await expect(verifyArtifactReferences([reference], probe)).resolves.toBeUndefined();
    expect(probe.assertVersioningEnabled).toHaveBeenCalledOnce();
    expect(probe.head).toHaveBeenCalledWith("qasey-artifacts/qasey/tenant-1/run-1/report.json");

    await expect(verifyArtifactReferences([{ ...reference, tenantId: "tenant-2" }], probe))
      .rejects.toThrow(/owner scope/u);
    const missingVersion: ArtifactProbe = {
      assertVersioningEnabled: async () => undefined,
      head: async () => ({
        sha256: "a".repeat(64),
        objectSha256: "a".repeat(64),
        contentType: "application/json",
        encryption: "AES256",
        applicationId: "qasey",
        tenantId: "tenant-1",
        runId: "run-1",
      }),
    };
    await expect(verifyArtifactReferences([reference], missingVersion)).rejects.toThrow(/version/u);
    const wrongOwner: ArtifactProbe = {
      assertVersioningEnabled: async () => undefined,
      head: async () => ({
        sha256: "a".repeat(64),
        objectSha256: "a".repeat(64),
        contentType: "application/json",
        versionId: "version-1",
        encryption: "AES256",
        applicationId: "qasey",
        tenantId: "tenant-2",
        runId: "run-1",
      }),
    };
    await expect(verifyArtifactReferences([reference], wrongOwner)).rejects.toThrow(/metadata/u);
    const wrongObjectChecksum: ArtifactProbe = {
      assertVersioningEnabled: async () => undefined,
      head: async () => ({
        sha256: "a".repeat(64),
        objectSha256: "b".repeat(64),
        contentType: "application/json",
        versionId: "version-1",
        encryption: "AES256",
        applicationId: "qasey",
        tenantId: "tenant-1",
        runId: "run-1",
      }),
    };
    await expect(verifyArtifactReferences([reference], wrongObjectChecksum)).rejects.toThrow(/metadata/u);
  });

  it("enforces the documented 15 minute RPO", () => {
    const incidentAt = "2026-08-26T10:15:00.000Z";
    expect(() => assertRecoveryPoint({
      manifest: manifest("2026-08-26T10:05:00.000Z"),
      artifactEvidence: artifactEvidence("2026-08-26T10:01:00.000Z"),
      incidentAt,
    })).not.toThrow();
    expect(() => assertRecoveryPoint({
      manifest: manifest("2026-08-26T09:59:59.000Z"),
      artifactEvidence: artifactEvidence("2026-08-26T10:01:00.000Z"),
      incidentAt,
    })).toThrow(/15 minute RPO/u);
    expect(() => assertRecoveryPoint({
      manifest: manifest("2026-08-26T10:10:00.000Z", "2026-08-26T09:59:59.000Z"),
      artifactEvidence: artifactEvidence("2026-08-26T10:01:00.000Z"),
      incidentAt,
    })).toThrow(/15 minute RPO/u);
  });

  it("recognizes supported PostgreSQL client version output", () => {
    expect(parsePostgresMajor("pg_dump (PostgreSQL) 17.6")).toBe(17);
    expect(parsePostgresMajor("psql (PostgreSQL) 16.10")).toBe(16);
    expect(() => parsePostgresMajor("unknown tool")).toThrow(/determine PostgreSQL/u);
  });

  it("accepts pnpm's forwarded option separator", () => {
    expect(parseOptions(["backup", "--", "--drill-id", "drill-1"])).toEqual({
      command: "backup",
      options: { "drill-id": "drill-1" },
    });
  });

  it("measures the four hour RTO from the operator-recorded drill start", () => {
    expect(assertRecoveryDuration("2026-08-26T10:00:00.000Z", "2026-08-26T13:59:59.999Z"))
      .toBe(14_399_999);
    expect(() => assertRecoveryDuration("2026-08-26T10:00:00.000Z", "2026-08-26T14:00:00.001Z"))
      .toThrow(/four hour RTO/u);
    expect(() => assertRecoveryDuration("2026-08-26T10:00:00.000Z", "2026-08-26T09:59:59.999Z"))
      .toThrow(/before the drill start/u);
  });

  it("documents an executable, evidence-producing drill and package entrypoints", async () => {
    const [runbook, readiness, packageJson, script] = await Promise.all([
      readFile(resolve(projectRoot, "docs/disaster-recovery.md"), "utf8"),
      readFile(resolve(projectRoot, "docs/production-readiness.md"), "utf8"),
      readFile(resolve(projectRoot, "package.json"), "utf8").then(JSON.parse) as Promise<{ scripts: Record<string, string> }>,
      readFile(resolve(projectRoot, "scripts/disaster-recovery.ts"), "utf8"),
    ]);

    expect(packageJson.scripts).toMatchObject({
      "dr:backup": "node --import tsx scripts/disaster-recovery.ts backup",
      "dr:restore": "node --import tsx scripts/disaster-recovery.ts restore",
      "dr:verify": "node --import tsx scripts/disaster-recovery.ts verify",
    });
    expect(runbook).toContain("RPO: 15 minutes");
    expect(runbook).toContain("RTO: 4 hours");
    expect(runbook).toContain("Redis is transient");
    expect(runbook).toContain("artifact-backup-evidence.json");
    expect(runbook).toContain("restore-evidence.json");
    expect(runbook).toContain("--drill-started-at");
    expect(readiness).toContain(
      "[x] 6.3 Add one-shot pre-deploy migration, expand-only migration gates, safe PostgreSQL/S3 restore tooling, and integrity checks.",
    );
    expect(script).not.toContain("stdio: \"inherit\"");
    expect(script).not.toMatch(/console\.(?:log|error)\([^)]*(?:DATABASE_URL|connectionString)/u);
  });

  it("exits non-zero with a redacted machine-readable failure", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveResult => {
      execFile(
        process.execPath,
        ["--import", "tsx", resolve(projectRoot, "scripts/disaster-recovery.ts")],
        { cwd: projectRoot, env: { PATH: process.env.PATH } },
        (error, stdout, stderr) => resolveResult({
          code: typeof error?.code === "number" ? error.code : error ? null : 0,
          stdout,
          stderr,
        }),
      );
    });
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `${JSON.stringify({ status: "failed", code: "ARGUMENT_INVALID" })}\n`,
    });
  });
});

function validSnapshot(): RestoreSnapshot {
  return {
    tables: [
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
    ],
    failedMigrationCount: 0,
    appliedMigrationCount: 4,
    tableCounts: {},
    workflowSnapshotCount: 1,
    invariantViolations: {
      orphan_run_events: 0,
      orphan_failure_inbox: 0,
      orphan_effect_receipts: 0,
      run_owner_mismatches: 0,
      orphan_tenant_owned_rows: 0,
      active_session_membership_mismatches: 0,
      invalid_failure_inbox_lifecycle: 0,
      invalid_effect_receipt_lifecycle: 0,
      invalid_artifact_arrays: 0,
      malformed_encrypted_credentials: 0,
    },
    credentialRowsChecked: 3,
    artifacts: [],
  };
}

function manifest(completedAt: string, recoveryPointAt = completedAt): BackupManifest {
  return {
    schemaVersion: 1,
    drillId: "drill-1",
    startedAt: completedAt,
    completedAt,
    rpoTargetMs: DR_RPO_TARGET_MS,
    rtoTargetMs: DR_RTO_TARGET_MS,
    database: {
      archive: "postgres.dump",
      format: "postgres-custom",
      sha256: "b".repeat(64),
      bytes: 1,
      recoveryPointAt,
      pgDumpVersion: "pg_dump (PostgreSQL) 17.6",
      sourceServerMajor: 17,
      appliedMigrationCount: 4,
    },
    artifacts: {
      evidence: "artifact-backup-evidence.json",
      sha256: "c".repeat(64),
      recoveryPointAt: completedAt,
      objectCount: 1,
    },
  };
}

function artifactEvidence(recoveryPointAt: string): ArtifactBackupEvidence {
  return {
    schemaVersion: 1,
    capturedAt: recoveryPointAt,
    recoveryPointAt,
    versioningEnabled: true,
    backupMode: "versioned-replication",
    replicationStatus: "enabled",
    retentionDays: 30,
    objectCount: 1,
    inventoryDigest: "d".repeat(64),
  };
}
