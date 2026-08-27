import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { OwnerScope } from "../../../packages/contracts/src/index.ts";

export type EffectReceiptStatus = "pending" | "succeeded" | "failed" | "unknown";

export interface EffectReceipt extends OwnerScope {
  idempotencyKey: string;
  runId: string;
  stepId: string;
  requestHash: string;
  status: EffectReceiptStatus;
  attempts: number;
  revision: number;
  leaseToken?: string;
  leaseExpiresAt?: string;
  result?: unknown;
  externalRef?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface BeginEffectInput extends OwnerScope {
  idempotencyKey: string;
  runId: string;
  stepId: string;
  requestHash: string;
  leaseMs?: number;
}

export interface EffectLease {
  receipt: EffectReceipt;
  leaseToken: string;
}

export class EffectReceiptError extends Error {
  constructor(
    readonly code: "in_progress" | "outcome_unknown" | "request_mismatch" | "lease_lost" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "EffectReceiptError";
  }
}

export class UnknownSideEffectOutcomeError extends Error {
  readonly code = "side_effect_outcome_unknown";
  constructor(message = "The external side effect outcome is unknown") { super(message); this.name = "UnknownSideEffectOutcomeError"; }
}

export interface EffectReceiptStore {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  begin(input: BeginEffectInput): Promise<EffectLease | { receipt: EffectReceipt; cached: true }>;
  succeed(owner: OwnerScope, idempotencyKey: string, leaseToken: string, result: unknown, externalRef?: string): Promise<EffectReceipt>;
  fail(owner: OwnerScope, idempotencyKey: string, leaseToken: string, errorCode: string, outcomeUnknown: boolean): Promise<EffectReceipt>;
  get(owner: OwnerScope, idempotencyKey: string): Promise<EffectReceipt | undefined>;
  close?(): Promise<void>;
}

export class InMemoryEffectReceiptStore implements EffectReceiptStore {
  private readonly receipts = new Map<string, EffectReceipt>();

  constructor(private readonly now: () => Date = () => new Date()) {}
  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async begin(input: BeginEffectInput): Promise<EffectLease | { receipt: EffectReceipt; cached: true }> {
    validateBegin(input);
    const key = ownerKey(input, input.idempotencyKey);
    const existing = this.receipts.get(key);
    if (existing) {
      assertRequestHash(existing, input.requestHash);
      if (existing.status === "succeeded") return { receipt: structuredClone(existing), cached: true };
      if (existing.status === "unknown") throw new EffectReceiptError("outcome_unknown", "External effect outcome requires operator reconciliation");
      if (existing.status === "pending") {
        if (!existing.leaseExpiresAt || Date.parse(existing.leaseExpiresAt) > this.now().getTime()) {
          throw new EffectReceiptError("in_progress", "External effect is already in progress");
        }
        existing.status = "unknown";
        existing.revision += 1;
        existing.updatedAt = this.now().toISOString();
        delete existing.leaseToken;
        delete existing.leaseExpiresAt;
        throw new EffectReceiptError("outcome_unknown", "Expired external effect lease has an unknown outcome");
      }
      return this.acquire(existing, input.leaseMs);
    }
    const now = this.now();
    const receipt: EffectReceipt = {
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      stepId: input.stepId,
      requestHash: input.requestHash,
      status: "failed",
      attempts: 0,
      revision: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.receipts.set(key, receipt);
    return this.acquire(receipt, input.leaseMs);
  }

  async succeed(owner: OwnerScope, idempotencyKey: string, leaseToken: string, result: unknown, externalRef?: string): Promise<EffectReceipt> {
    const receipt = this.requireLease(owner, idempotencyKey, leaseToken);
    receipt.status = "succeeded";
    receipt.result = structuredClone(result);
    if (externalRef) receipt.externalRef = externalRef;
    receipt.completedAt = this.now().toISOString();
    delete receipt.leaseToken;
    delete receipt.leaseExpiresAt;
    receipt.revision += 1;
    receipt.updatedAt = this.now().toISOString();
    return structuredClone(receipt);
  }

  async fail(owner: OwnerScope, idempotencyKey: string, leaseToken: string, errorCode: string, outcomeUnknown: boolean): Promise<EffectReceipt> {
    const receipt = this.requireLease(owner, idempotencyKey, leaseToken);
    receipt.status = outcomeUnknown ? "unknown" : "failed";
    receipt.lastErrorCode = normalizeErrorCode(errorCode);
    delete receipt.leaseToken;
    delete receipt.leaseExpiresAt;
    receipt.revision += 1;
    receipt.updatedAt = this.now().toISOString();
    return structuredClone(receipt);
  }

  async get(owner: OwnerScope, idempotencyKey: string): Promise<EffectReceipt | undefined> {
    const receipt = this.receipts.get(ownerKey(owner, idempotencyKey));
    return receipt ? structuredClone(receipt) : undefined;
  }

  async close(): Promise<void> { this.receipts.clear(); }

  private acquire(receipt: EffectReceipt, leaseMs = 60_000): EffectLease {
    const token = randomUUID();
    receipt.status = "pending";
    receipt.attempts += 1;
    receipt.revision += 1;
    receipt.leaseToken = token;
    receipt.leaseExpiresAt = new Date(this.now().getTime() + boundedLease(leaseMs)).toISOString();
    receipt.updatedAt = this.now().toISOString();
    return { receipt: structuredClone(receipt), leaseToken: token };
  }

  private requireLease(owner: OwnerScope, idempotencyKey: string, leaseToken: string): EffectReceipt {
    const receipt = this.receipts.get(ownerKey(owner, idempotencyKey));
    if (!receipt) throw new EffectReceiptError("not_found", "Effect receipt was not found");
    if (receipt.status !== "pending" || receipt.leaseToken !== leaseToken) throw new EffectReceiptError("lease_lost", "Effect receipt lease is no longer owned");
    return receipt;
  }
}

interface EffectReceiptRow {
  application_id: string;
  tenant_id: string;
  idempotency_key: string;
  run_id: string;
  step_id: string;
  request_hash: string;
  status: EffectReceiptStatus;
  attempts: number;
  revision: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  result: unknown;
  external_ref: string | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export class PrismaEffectReceiptStore implements EffectReceiptStore {
  private initialized?: Promise<void>;
  constructor(private readonly prisma: PrismaClient) {}
  init(): Promise<void> { this.initialized ??= this.prisma.$connect(); return this.initialized; }
  private ready(): Promise<void> { return this.initialized ?? Promise.reject(new Error("PrismaEffectReceiptStore has not been initialized")); }
  async healthCheck(): Promise<void> { await this.ready(); await this.prisma.$queryRaw`SELECT 1`; }

  async begin(input: BeginEffectInput): Promise<EffectLease | { receipt: EffectReceipt; cached: true }> {
    await this.ready();
    validateBegin(input);
    const token = randomUUID();
    const leaseMs = boundedLease(input.leaseMs ?? 60_000);
    const inserted = await this.prisma.$queryRawUnsafe<EffectReceiptRow[]>(
      `INSERT INTO platform_workflow_effect_receipts
       (application_id,tenant_id,idempotency_key,run_id,step_id,request_hash,status,attempts,revision,lease_token,lease_expires_at)
       VALUES($1,$2,$3,$4,$5,$6,'pending',1,1,$7::uuid,now()+($8 * interval '1 millisecond'))
       ON CONFLICT DO NOTHING RETURNING *`,
      input.applicationId, input.tenantId, input.idempotencyKey, input.runId, input.stepId, input.requestHash, token, leaseMs,
    );
    if (inserted[0]) return { receipt: rowToReceipt(inserted[0]), leaseToken: token };
    const current = await this.get(input, input.idempotencyKey);
    if (!current) throw new EffectReceiptError("not_found", "Effect receipt disappeared during acquisition");
    assertRequestHash(current, input.requestHash);
    if (current.status === "succeeded") return { receipt: current, cached: true };
    if (current.status === "unknown") throw new EffectReceiptError("outcome_unknown", "External effect outcome requires operator reconciliation");
    if (current.status === "pending") {
      if (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) > Date.now()) throw new EffectReceiptError("in_progress", "External effect is already in progress");
      await this.prisma.$executeRawUnsafe(
        `UPDATE platform_workflow_effect_receipts SET status='unknown',lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
         WHERE application_id=$1 AND tenant_id=$2 AND idempotency_key=$3 AND status='pending' AND lease_expires_at <= now()`,
        input.applicationId, input.tenantId, input.idempotencyKey,
      );
      throw new EffectReceiptError("outcome_unknown", "Expired external effect lease has an unknown outcome");
    }
    const acquired = await this.prisma.$queryRawUnsafe<EffectReceiptRow[]>(
      `UPDATE platform_workflow_effect_receipts SET status='pending',attempts=attempts+1,revision=revision+1,
       lease_token=$4::uuid,lease_expires_at=now()+($5 * interval '1 millisecond'),updated_at=now()
       WHERE application_id=$1 AND tenant_id=$2 AND idempotency_key=$3 AND status='failed' RETURNING *`,
      input.applicationId, input.tenantId, input.idempotencyKey, token, leaseMs,
    );
    if (!acquired[0]) throw new EffectReceiptError("in_progress", "External effect acquisition raced with another worker");
    return { receipt: rowToReceipt(acquired[0]), leaseToken: token };
  }

  async succeed(owner: OwnerScope, idempotencyKey: string, leaseToken: string, result: unknown, externalRef?: string): Promise<EffectReceipt> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<EffectReceiptRow[]>(
      `UPDATE platform_workflow_effect_receipts SET status='succeeded',result=$5::jsonb,external_ref=$6,
       completed_at=now(),lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
       WHERE application_id=$1 AND tenant_id=$2 AND idempotency_key=$3 AND status='pending' AND lease_token=$4::uuid RETURNING *`,
      owner.applicationId, owner.tenantId, idempotencyKey, leaseToken, JSON.stringify(result ?? null), externalRef ?? null,
    );
    if (!rows[0]) throw new EffectReceiptError("lease_lost", "Effect receipt lease is no longer owned");
    return rowToReceipt(rows[0]);
  }

  async fail(owner: OwnerScope, idempotencyKey: string, leaseToken: string, errorCode: string, outcomeUnknown: boolean): Promise<EffectReceipt> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<EffectReceiptRow[]>(
      `UPDATE platform_workflow_effect_receipts SET status=$5,last_error_code=$6,lease_token=NULL,lease_expires_at=NULL,
       revision=revision+1,updated_at=now()
       WHERE application_id=$1 AND tenant_id=$2 AND idempotency_key=$3 AND status='pending' AND lease_token=$4::uuid RETURNING *`,
      owner.applicationId, owner.tenantId, idempotencyKey, leaseToken, outcomeUnknown ? "unknown" : "failed", normalizeErrorCode(errorCode),
    );
    if (!rows[0]) throw new EffectReceiptError("lease_lost", "Effect receipt lease is no longer owned");
    return rowToReceipt(rows[0]);
  }

  async get(owner: OwnerScope, idempotencyKey: string): Promise<EffectReceipt | undefined> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<EffectReceiptRow[]>(
      `${SELECT_RECEIPT} WHERE application_id=$1 AND tenant_id=$2 AND idempotency_key=$3`,
      owner.applicationId, owner.tenantId, idempotencyKey,
    );
    return rows[0] ? rowToReceipt(rows[0]) : undefined;
  }
  async close(): Promise<void> {}
}

export class SideEffectExecutor {
  constructor(private readonly receipts: EffectReceiptStore) {}

  async execute<T>(input: {
    owner: OwnerScope;
    runId: string;
    stepId: string;
    businessKey: string;
    request: unknown;
    operation: (idempotencyKey: string) => Promise<{ result: T; externalRef?: string }>;
  }): Promise<T> {
    const idempotencyKey = stableEffectKey(input.owner, input.runId, input.stepId, input.businessKey);
    const requestHash = hashCanonical(input.request);
    const begun = await this.receipts.begin({ ...input.owner, idempotencyKey, runId: input.runId, stepId: input.stepId, requestHash });
    if ("cached" in begun) return structuredClone(begun.receipt.result) as T;
    try {
      const outcome = await input.operation(idempotencyKey);
      await this.receipts.succeed(input.owner, idempotencyKey, begun.leaseToken, outcome.result, outcome.externalRef);
      return outcome.result;
    } catch (error) {
      const outcomeUnknown = hasUnknownSideEffectOutcomeCode(error);
      await this.receipts.fail(
        input.owner,
        idempotencyKey,
        begun.leaseToken,
        error instanceof Error && "code" in error ? String(error.code) : "EXTERNAL_EFFECT_FAILED",
        outcomeUnknown,
      );
      throw error;
    }
  }
}

function hasUnknownSideEffectOutcomeCode(error: unknown): error is { readonly code: "side_effect_outcome_unknown" } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "side_effect_outcome_unknown";
}

const SELECT_RECEIPT = `SELECT application_id,tenant_id,idempotency_key,run_id,step_id,request_hash,status,attempts,revision,
lease_token,lease_expires_at,result,external_ref,last_error_code,created_at,updated_at,completed_at
FROM platform_workflow_effect_receipts`;

export function stableEffectKey(owner: OwnerScope, runId: string, stepId: string, businessKey: string): string {
  return createHash("sha256").update(["qasey-effect-v1", owner.applicationId, owner.tenantId, runId, stepId, businessKey].join("\0")).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  if (["string", "number", "boolean"].includes(typeof value) || value === null) return value;
  return String(value);
}

function validateBegin(input: BeginEffectInput): void {
  for (const [field, value] of Object.entries({
    applicationId: input.applicationId, tenantId: input.tenantId, idempotencyKey: input.idempotencyKey,
    runId: input.runId, stepId: input.stepId, requestHash: input.requestHash,
  })) if (!value.trim()) throw new Error(`${field} is required`);
}

function assertRequestHash(receipt: EffectReceipt, requestHash: string): void {
  if (receipt.requestHash !== requestHash) throw new EffectReceiptError("request_mismatch", "Idempotency key was reused with a different request");
}

function boundedLease(value: number): number {
  if (!Number.isInteger(value) || value < 5_000 || value > 15 * 60_000) throw new Error("Effect receipt lease must be between 5 seconds and 15 minutes");
  return value;
}

function normalizeErrorCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_.-]/gu, "_").slice(0, 100) || "EXTERNAL_EFFECT_FAILED";
}

function ownerKey(owner: OwnerScope, idempotencyKey: string): string {
  return `${owner.applicationId}\0${owner.tenantId}\0${idempotencyKey}`;
}

function rowToReceipt(row: EffectReceiptRow): EffectReceipt {
  return {
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    stepId: row.step_id,
    requestHash: row.request_hash,
    status: row.status,
    attempts: row.attempts,
    revision: row.revision,
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at.toISOString() } : {}),
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.external_ref ? { externalRef: row.external_ref } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
  };
}
