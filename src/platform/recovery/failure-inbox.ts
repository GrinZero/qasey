import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { E2ERun, OwnerScope } from "../../../packages/contracts/src/index.ts";
import { RunRevisionConflictError, type RunRepository } from "../../../packages/domain/src/index.ts";
import { productionSignals } from "../observability/production-signals.ts";

export type FailureReasonCode = "heartbeat_timeout" | "execution_deadline" | "orphaned_execution" | "side_effect_unknown";
export type FailureInboxStatus = "pending" | "redriving" | "redriven" | "exhausted" | "closed";

export interface FailureInboxItem extends OwnerScope {
  id: string;
  runId: string;
  workflowId: string;
  reasonCode: FailureReasonCode;
  errorCode: string;
  message: string;
  status: FailureInboxStatus;
  attempts: number;
  maxAttempts: number;
  revision: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  redriveRunId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface RecordFailureInput extends OwnerScope {
  runId: string;
  workflowId: string;
  reasonCode: FailureReasonCode;
  errorCode: string;
  message: string;
  maxAttempts?: number;
}

export class FailureInboxError extends Error {
  constructor(
    readonly code: "not_found" | "revision_conflict" | "invalid_status" | "attempts_exhausted",
    message: string,
  ) {
    super(message);
    this.name = "FailureInboxError";
  }
}

export interface FailureInboxStore {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  record(input: RecordFailureInput): Promise<FailureInboxItem>;
  get(owner: OwnerScope, id: string): Promise<FailureInboxItem | undefined>;
  list(owner: OwnerScope, status?: FailureInboxStatus, limit?: number): Promise<readonly FailureInboxItem[]>;
  claim(owner: OwnerScope, id: string, expectedRevision: number, actorId: string): Promise<FailureInboxItem>;
  complete(owner: OwnerScope, id: string, expectedRevision: number, actorId: string, redriveRunId: string): Promise<FailureInboxItem>;
  failAttempt(owner: OwnerScope, id: string, expectedRevision: number, message: string, nextAttemptAt: Date): Promise<FailureInboxItem>;
  closeItem(owner: OwnerScope, id: string, expectedRevision: number, actorId: string): Promise<FailureInboxItem>;
  close?(): Promise<void>;
}

export class InMemoryFailureInboxStore implements FailureInboxStore {
  private readonly records = new Map<string, FailureInboxItem>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async record(input: RecordFailureInput): Promise<FailureInboxItem> {
    const existing = [...this.records.values()].find(item => sameFailure(item, input));
    const now = this.now().toISOString();
    if (existing) {
      existing.lastSeenAt = now;
      existing.message = sanitizeFailureMessage(input.message);
      return structuredClone(existing);
    }
    const item: FailureInboxItem = {
      applicationId: required(input.applicationId, "applicationId"),
      tenantId: required(input.tenantId, "tenantId"),
      id: randomUUID(),
      runId: required(input.runId, "runId"),
      workflowId: required(input.workflowId, "workflowId"),
      reasonCode: input.reasonCode,
      errorCode: safeCode(input.errorCode),
      message: sanitizeFailureMessage(input.message),
      status: "pending",
      attempts: 0,
      maxAttempts: boundedAttempts(input.maxAttempts),
      revision: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.records.set(item.id, item);
    return structuredClone(item);
  }

  async get(owner: OwnerScope, id: string): Promise<FailureInboxItem | undefined> {
    const item = this.records.get(id);
    return item && sameOwner(item, owner) ? structuredClone(item) : undefined;
  }

  async list(owner: OwnerScope, status?: FailureInboxStatus, limit = 100): Promise<readonly FailureInboxItem[]> {
    return [...this.records.values()]
      .filter(item => sameOwner(item, owner) && (!status || item.status === status))
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, boundedLimit(limit))
      .map(item => structuredClone(item));
  }

  async claim(owner: OwnerScope, id: string, expectedRevision: number, _actorId: string): Promise<FailureInboxItem> {
    const item = this.require(owner, id, expectedRevision);
    if (item.status !== "pending") throw new FailureInboxError("invalid_status", "Failure inbox item is not pending");
    if (item.attempts >= item.maxAttempts) throw new FailureInboxError("attempts_exhausted", "Failure inbox retry limit is exhausted");
    item.status = "redriving";
    item.attempts += 1;
    item.lastAttemptAt = this.now().toISOString();
    delete item.nextAttemptAt;
    bump(item);
    return structuredClone(item);
  }

  async complete(owner: OwnerScope, id: string, expectedRevision: number, actorId: string, redriveRunId: string): Promise<FailureInboxItem> {
    const item = this.require(owner, id, expectedRevision);
    if (item.status !== "redriving") throw new FailureInboxError("invalid_status", "Failure inbox item is not being redriven");
    item.status = "redriven";
    item.redriveRunId = required(redriveRunId, "redriveRunId");
    item.resolvedAt = this.now().toISOString();
    item.resolvedBy = actorId;
    bump(item);
    return structuredClone(item);
  }

  async failAttempt(owner: OwnerScope, id: string, expectedRevision: number, message: string, nextAttemptAt: Date): Promise<FailureInboxItem> {
    const item = this.require(owner, id, expectedRevision);
    if (item.status !== "redriving") throw new FailureInboxError("invalid_status", "Failure inbox item is not being redriven");
    item.message = sanitizeFailureMessage(message);
    item.status = item.attempts >= item.maxAttempts ? "exhausted" : "pending";
    if (item.status === "pending") item.nextAttemptAt = nextAttemptAt.toISOString();
    else item.resolvedAt = this.now().toISOString();
    bump(item);
    return structuredClone(item);
  }

  async closeItem(owner: OwnerScope, id: string, expectedRevision: number, actorId: string): Promise<FailureInboxItem> {
    const item = this.require(owner, id, expectedRevision);
    if (["redriven", "closed"].includes(item.status)) throw new FailureInboxError("invalid_status", "Failure inbox item is already resolved");
    item.status = "closed";
    item.resolvedAt = this.now().toISOString();
    item.resolvedBy = actorId;
    bump(item);
    return structuredClone(item);
  }

  async close(): Promise<void> { this.records.clear(); }

  private require(owner: OwnerScope, id: string, expectedRevision: number): FailureInboxItem {
    const item = this.records.get(id);
    if (!item || !sameOwner(item, owner)) throw new FailureInboxError("not_found", "Failure inbox item was not found");
    if (item.revision !== expectedRevision) throw new FailureInboxError("revision_conflict", "Failure inbox item changed; reload and retry");
    return item;
  }
}

interface FailureInboxRow {
  application_id: string;
  tenant_id: string;
  id: string;
  run_id: string;
  workflow_id: string;
  reason_code: FailureReasonCode;
  error_code: string;
  message: string;
  status: FailureInboxStatus;
  attempts: number;
  max_attempts: number;
  revision: number;
  first_seen_at: Date;
  last_seen_at: Date;
  last_attempt_at: Date | null;
  next_attempt_at: Date | null;
  redrive_run_id: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
}

export class PrismaFailureInboxStore implements FailureInboxStore {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient) {}
  init(): Promise<void> { this.initialized ??= this.prisma.$connect(); return this.initialized; }
  private ready(): Promise<void> { return this.initialized ?? Promise.reject(new Error("PrismaFailureInboxStore has not been initialized")); }
  async healthCheck(): Promise<void> { await this.ready(); await this.prisma.$queryRaw`SELECT 1`; }

  async record(input: RecordFailureInput): Promise<FailureInboxItem> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<FailureInboxRow[]>(
      `INSERT INTO platform_workflow_failure_inbox
       (application_id,tenant_id,id,run_id,workflow_id,reason_code,error_code,message,status,attempts,max_attempts,revision)
       VALUES($1,$2,$3::uuid,$4,$5,$6,$7,$8,'pending',0,$9,1)
       ON CONFLICT(application_id,tenant_id,run_id,reason_code) DO UPDATE
       SET last_seen_at=now(),message=EXCLUDED.message
       RETURNING *`,
      required(input.applicationId, "applicationId"), required(input.tenantId, "tenantId"), randomUUID(),
      required(input.runId, "runId"), required(input.workflowId, "workflowId"), input.reasonCode,
      safeCode(input.errorCode), sanitizeFailureMessage(input.message), boundedAttempts(input.maxAttempts),
    );
    return rowToItem(rows[0]!);
  }

  async get(owner: OwnerScope, id: string): Promise<FailureInboxItem | undefined> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<FailureInboxRow[]>(
      `${SELECT_FAILURE} WHERE application_id=$1 AND tenant_id=$2 AND id=$3::uuid`, owner.applicationId, owner.tenantId, id,
    );
    return rows[0] ? rowToItem(rows[0]) : undefined;
  }

  async list(owner: OwnerScope, status?: FailureInboxStatus, limit = 100): Promise<readonly FailureInboxItem[]> {
    await this.ready();
    const rows = status
      ? await this.prisma.$queryRawUnsafe<FailureInboxRow[]>(
          `${SELECT_FAILURE} WHERE application_id=$1 AND tenant_id=$2 AND status=$3 ORDER BY last_seen_at DESC LIMIT $4`,
          owner.applicationId, owner.tenantId, status, boundedLimit(limit),
        )
      : await this.prisma.$queryRawUnsafe<FailureInboxRow[]>(
          `${SELECT_FAILURE} WHERE application_id=$1 AND tenant_id=$2 ORDER BY last_seen_at DESC LIMIT $3`,
          owner.applicationId, owner.tenantId, boundedLimit(limit),
        );
    return rows.map(rowToItem);
  }

  async claim(owner: OwnerScope, id: string, expectedRevision: number, _actorId: string): Promise<FailureInboxItem> {
    return this.transition(owner, id, expectedRevision,
      `status='redriving',attempts=attempts+1,last_attempt_at=now(),next_attempt_at=NULL`,
      `status='pending' AND attempts < max_attempts`);
  }

  async complete(owner: OwnerScope, id: string, expectedRevision: number, actorId: string, redriveRunId: string): Promise<FailureInboxItem> {
    return this.transition(owner, id, expectedRevision,
      `status='redriven',redrive_run_id=$4,resolved_at=now(),resolved_by=$5`,
      `status='redriving'`, [required(redriveRunId, "redriveRunId"), actorId]);
  }

  async failAttempt(owner: OwnerScope, id: string, expectedRevision: number, message: string, nextAttemptAt: Date): Promise<FailureInboxItem> {
    return this.transition(owner, id, expectedRevision,
      `status=CASE WHEN attempts >= max_attempts THEN 'exhausted' ELSE 'pending' END,
       message=$4,next_attempt_at=CASE WHEN attempts >= max_attempts THEN NULL ELSE $5 END,
       resolved_at=CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END`,
      `status='redriving'`, [sanitizeFailureMessage(message), nextAttemptAt]);
  }

  async closeItem(owner: OwnerScope, id: string, expectedRevision: number, actorId: string): Promise<FailureInboxItem> {
    return this.transition(owner, id, expectedRevision,
      `status='closed',resolved_at=now(),resolved_by=$4`,
      `status NOT IN ('redriven','closed')`, [actorId]);
  }

  async close(): Promise<void> {}

  private async transition(
    owner: OwnerScope,
    id: string,
    expectedRevision: number,
    setClause: string,
    statusPredicate: string,
    extra: unknown[] = [],
  ): Promise<FailureInboxItem> {
    await this.ready();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TypeError("expectedRevision must be a positive safe integer");
    const rows = await this.prisma.$queryRawUnsafe<FailureInboxRow[]>(
      `UPDATE platform_workflow_failure_inbox SET ${setClause},revision=revision+1,last_seen_at=now()
       WHERE application_id=$1 AND tenant_id=$2 AND id=$3::uuid AND revision=${expectedRevision} AND ${statusPredicate}
       RETURNING *`,
      owner.applicationId, owner.tenantId, id, ...extra,
    );
    if (rows[0]) return rowToItem(rows[0]);
    const current = await this.get(owner, id);
    if (!current) throw new FailureInboxError("not_found", "Failure inbox item was not found");
    if (current.revision !== expectedRevision) throw new FailureInboxError("revision_conflict", "Failure inbox item changed; reload and retry");
    if (current.attempts >= current.maxAttempts) throw new FailureInboxError("attempts_exhausted", "Failure inbox retry limit is exhausted");
    throw new FailureInboxError("invalid_status", "Failure inbox item cannot make the requested transition");
  }
}

const SELECT_FAILURE = `SELECT application_id,tenant_id,id,run_id,workflow_id,reason_code,error_code,message,status,
attempts,max_attempts,revision,first_seen_at,last_seen_at,last_attempt_at,next_attempt_at,redrive_run_id,resolved_at,resolved_by
FROM platform_workflow_failure_inbox`;

export const STALE_RUN_STATUSES = [
  "queued", "preparing_workspace", "authoring", "author_running", "repairing", "clean_verifying",
] as const;

export class StaleRunReconciler {
  constructor(
    private readonly runs: RunRepository,
    private readonly failures: FailureInboxStore,
    private readonly heartbeatTimeoutMs: number,
    private readonly batchSize = 100,
  ) {
    if (!Number.isInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 60_000) throw new Error("Run heartbeat timeout must be at least one minute");
  }

  async runOnce(now = new Date()): Promise<{ inspected: number; failed: number; conflicted: number }> {
    const stale = await this.runs.listStale(new Date(now.getTime() - this.heartbeatTimeoutMs), STALE_RUN_STATUSES, this.batchSize);
    let failed = 0;
    let conflicted = 0;
    for (const run of stale) {
      const owner = { applicationId: run.applicationId, tenantId: run.tenantId };
      observeSignal(() => productionSignals.setStuckRun({
        tenantId: run.tenantId,
        runId: run.id,
        ageSeconds: Math.max(0, (now.getTime() - Date.parse(run.updatedAt)) / 1_000),
      }));
      const item = await this.failures.record({
        ...owner,
        runId: run.id,
        workflowId: "qasey-e2e-lifecycle",
        reasonCode: "heartbeat_timeout",
        errorCode: "RUN_HEARTBEAT_TIMEOUT",
        message: "Run exceeded the configured heartbeat recovery window",
      });
      try {
        await this.runs.update(owner, run.id, run.revision, {
          status: "failed",
          error: "Run exceeded the configured heartbeat recovery window",
        });
        await this.runs.addEvent(owner, run.id, "run.reconciled_failed", "Stale run moved to the failure inbox", { failureInboxId: item.id });
        failed += 1;
        observeSignal(() => {
          productionSignals.incrementReconciled(run.tenantId, "failed");
          productionSignals.clearStuckRun(run.tenantId, run.id);
        });
      } catch (error) {
        if (!(error instanceof RunRevisionConflictError)) throw error;
        conflicted += 1;
        observeSignal(() => {
          productionSignals.incrementReconciled(run.tenantId, "conflicted");
          productionSignals.clearStuckRun(run.tenantId, run.id);
        });
        const current = await this.runs.get(owner, run.id);
        if (current && current.status !== "failed") {
          await this.failures.closeItem(owner, item.id, item.revision, "stale-run-reconciler").catch(() => undefined);
        }
      }
    }
    return { inspected: stale.length, failed, conflicted };
  }
}

export interface FailureRedriveAudit {
  write(input: {
    requestId: string;
    tenantId: string;
    subjectId: string;
    applicationId: string;
    resourceType: string;
    resourceId: string;
    action: string;
    decision: "allow" | "deny";
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export class FailureRedriveService {
  constructor(
    private readonly failures: FailureInboxStore,
    private readonly runs: RunRepository,
    private readonly createRedrive: (owner: OwnerScope, sourceRunId: string) => Promise<E2ERun>,
    private readonly audit: FailureRedriveAudit,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async redrive(input: { owner: OwnerScope; failureId: string; expectedRevision: number; actorId: string; requestId: string }): Promise<FailureInboxItem> {
    const sourceFailure = await this.failures.get(input.owner, input.failureId);
    if (!sourceFailure) throw new FailureInboxError("not_found", "Failure inbox item was not found");
    const sourceRun = await this.runs.get(input.owner, sourceFailure.runId);
    if (!sourceRun || sourceRun.status !== "failed") throw new FailureInboxError("invalid_status", "Only a failed source run can be redriven");
    const claimed = await this.failures.claim(input.owner, input.failureId, input.expectedRevision, input.actorId);
    try {
      const redrive = await this.createRedrive(input.owner, sourceFailure.runId);
      const completed = await this.failures.complete(input.owner, claimed.id, claimed.revision, input.actorId, redrive.id);
      await this.audit.write({
        requestId: input.requestId,
        tenantId: input.owner.tenantId,
        subjectId: input.actorId,
        applicationId: input.owner.applicationId,
        resourceType: "workflow-failure",
        resourceId: claimed.id,
        action: "redrive",
        decision: "allow",
        reason: "operator_redrive",
        metadata: { sourceRunId: sourceFailure.runId, redriveRunId: redrive.id, attempt: claimed.attempts },
      });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, claimed.attempts - 1));
      await this.failures.failAttempt(input.owner, claimed.id, claimed.revision, message, new Date(this.now().getTime() + delayMs));
      throw error;
    }
  }
}

function sameFailure(item: FailureInboxItem, input: RecordFailureInput): boolean {
  return sameOwner(item, input) && item.runId === input.runId && item.reasonCode === input.reasonCode;
}

function sameOwner(item: OwnerScope, owner: OwnerScope): boolean {
  return item.applicationId === owner.applicationId && item.tenantId === owner.tenantId;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function safeCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_.-]/gu, "_").slice(0, 100);
  return normalized || "UNKNOWN_FAILURE";
}

function sanitizeFailureMessage(value: string): string {
  return value.replace(/((?:bearer|token|secret|password|api[_-]?key))\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]").slice(0, 2_000);
}

function boundedAttempts(value: number | undefined): number {
  const attempts = value ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new Error("Failure inbox maxAttempts must be between 1 and 20");
  return attempts;
}

function boundedLimit(value: number): number { return Math.min(Math.max(Math.floor(value), 1), 500); }
function bump(item: FailureInboxItem): void { item.revision += 1; }
function observeSignal(callback: () => void): void { try { callback(); } catch { /* Telemetry cannot block recovery. */ } }

function rowToItem(row: FailureInboxRow): FailureInboxItem {
  return {
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    id: row.id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    reasonCode: row.reason_code,
    errorCode: row.error_code,
    message: row.message,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    revision: row.revision,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at.toISOString() } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at.toISOString() } : {}),
    ...(row.redrive_run_id ? { redriveRunId: row.redrive_run_id } : {}),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
  };
}
