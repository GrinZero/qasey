import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, QaseySandboxLease } from "@prisma/client";
import type { SandboxLease, SandboxLeaseScope } from "./sandbox-protocol.ts";
import { decryptSandboxSecret, encryptSandboxSecret } from "./sandbox-secrets.ts";

export class SandboxCapacityError extends Error {
  constructor() {
    super("Qasey sandbox pool is at capacity");
    this.name = "SandboxCapacityError";
  }
}

export interface SandboxLeaseStore {
  init(): Promise<void>;
  healthCheck(): Promise<void>;
  acquire(scope: SandboxLeaseScope): Promise<SandboxLease>;
  reassign(scope: SandboxLeaseScope, failedOrdinal: number): Promise<SandboxLease>;
  touch(scope: SandboxLeaseScope): Promise<void>;
  release(scope: SandboxLeaseScope): Promise<void>;
  close(): Promise<void>;
}

interface LeaseStoreOptions {
  replicas: number;
  maxSessionsPerReplica: number;
  idleTtlMs: number;
  encryptionKey: string;
  now?: () => Date;
}

export class InMemorySandboxLeaseStore implements SandboxLeaseStore {
  private readonly leases = new Map<string, SandboxLease>();
  private readonly now: () => Date;

  constructor(private readonly options: LeaseStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}
  async close(): Promise<void> { this.leases.clear(); }

  async acquire(scope: SandboxLeaseScope): Promise<SandboxLease> {
    this.expireIdle();
    const key = leaseKey(scope);
    const current = this.leases.get(key);
    if (current?.state === "active") {
      const updated = { ...current, lastActivityAt: this.now().toISOString() };
      this.leases.set(key, updated);
      return structuredClone(updated);
    }
    const ordinal = selectOrdinal([...this.leases.values()], this.options, current?.ordinal);
    const lease: SandboxLease = {
      ...scope,
      workspaceId: workspaceId(scope),
      ordinal,
      generation: (current?.generation ?? 0) + 1,
      token: randomBytes(32).toString("base64url"),
      state: "active",
      lastActivityAt: this.now().toISOString(),
    };
    this.leases.set(key, lease);
    return structuredClone(lease);
  }

  async reassign(scope: SandboxLeaseScope, failedOrdinal: number): Promise<SandboxLease> {
    this.expireIdle();
    const key = leaseKey(scope);
    const current = this.leases.get(key);
    const ordinal = selectOrdinal([...this.leases.values()], this.options, undefined, new Set([failedOrdinal]));
    const lease: SandboxLease = {
      ...scope,
      workspaceId: workspaceId(scope),
      ordinal,
      generation: (current?.generation ?? 0) + 1,
      token: randomBytes(32).toString("base64url"),
      state: "active",
      lastActivityAt: this.now().toISOString(),
    };
    this.leases.set(key, lease);
    return structuredClone(lease);
  }

  async touch(scope: SandboxLeaseScope): Promise<void> {
    const current = this.leases.get(leaseKey(scope));
    if (current) current.lastActivityAt = this.now().toISOString();
  }

  async release(scope: SandboxLeaseScope): Promise<void> {
    const current = this.leases.get(leaseKey(scope));
    if (current) current.state = "idle";
  }

  private expireIdle(): void {
    const cutoff = this.now().getTime() - this.options.idleTtlMs;
    for (const lease of this.leases.values()) {
      if (lease.state === "active" && Date.parse(lease.lastActivityAt) <= cutoff) lease.state = "idle";
    }
  }
}

interface LeaseRow {
  application_id: string;
  tenant_id: string;
  session_id: string;
  workspace_id: string;
  sandbox_ordinal: number;
  lease_generation: number;
  encrypted_token: string;
  state: "active" | "idle";
  last_activity_at: Date;
}

export class PrismaSandboxLeaseStore implements SandboxLeaseStore {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient, private readonly options: LeaseStoreOptions) {}

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async acquire(scope: SandboxLeaseScope): Promise<SandboxLease> {
    await this.ready();
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('qasey-sandbox-capacity-v1'))::text AS lock`;
      const cutoff = new Date(Date.now() - this.options.idleTtlMs);
      await tx.qaseySandboxLease.updateMany({
        where: { state: "active", lastActivityAt: { lte: cutoff } },
        data: { state: "idle", updatedAt: new Date() },
      });
      const currentRows = await tx.$queryRaw<LeaseRow[]>`
        SELECT * FROM qasey_sandbox_leases
        WHERE application_id = ${scope.applicationId} AND tenant_id = ${scope.tenantId}
          AND session_id = ${scope.sessionId} FOR UPDATE`;
      const current = currentRows[0];
      if (current?.state === "active") {
        const now = new Date();
        await tx.qaseySandboxLease.update({
          where: { applicationId_tenantId_sessionId: scope },
          data: { lastActivityAt: now, updatedAt: now },
        });
        return rowToLease(current, this.options.encryptionKey, now.toISOString());
      }
      const counts = await tx.qaseySandboxLease.groupBy({
        by: ["sandboxOrdinal"], where: { state: "active" }, _count: true,
      });
      const active = new Map(counts.map(row => [row.sandboxOrdinal, row._count]));
      const ordinal = chooseOrdinal(active, this.options, current?.sandbox_ordinal);
      const token = randomBytes(32).toString("base64url");
      const generation = (current?.lease_generation ?? 0) + 1;
      const id = workspaceId(scope);
      const now = new Date();
      const row = await tx.qaseySandboxLease.upsert({
        where: { applicationId_tenantId_sessionId: scope },
        create: { ...scope, workspaceId: id, sandboxOrdinal: ordinal, leaseGeneration: generation,
          encryptedToken: encryptSandboxSecret(token, this.options.encryptionKey), state: "active",
          lastActivityAt: now, updatedAt: now },
        update: { workspaceId: id, sandboxOrdinal: ordinal, leaseGeneration: generation,
          encryptedToken: encryptSandboxSecret(token, this.options.encryptionKey), state: "active",
          lastActivityAt: now, updatedAt: now },
      });
      return prismaLeaseToLease(row, this.options.encryptionKey);
    });
  }

  async reassign(scope: SandboxLeaseScope, failedOrdinal: number): Promise<SandboxLease> {
    await this.ready();
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('qasey-sandbox-capacity-v1'))::text AS lock`;
      const cutoff = new Date(Date.now() - this.options.idleTtlMs);
      await tx.qaseySandboxLease.updateMany({
        where: { state: "active", lastActivityAt: { lte: cutoff } },
        data: { state: "idle", updatedAt: new Date() },
      });
      const currentRows = await tx.$queryRaw<LeaseRow[]>`
        SELECT * FROM qasey_sandbox_leases
        WHERE application_id = ${scope.applicationId} AND tenant_id = ${scope.tenantId}
          AND session_id = ${scope.sessionId} FOR UPDATE`;
      const current = currentRows[0];
      if (!current) throw new Error("Cannot reassign a sandbox lease that does not exist");
      const counts = await tx.qaseySandboxLease.groupBy({
        by: ["sandboxOrdinal"], where: { state: "active" }, _count: true,
      });
      const active = new Map(counts.map(row => [row.sandboxOrdinal, row._count]));
      const ordinal = chooseOrdinal(active, this.options, undefined, new Set([failedOrdinal]));
      const token = randomBytes(32).toString("base64url");
      const now = new Date();
      const row = await tx.qaseySandboxLease.update({
        where: { applicationId_tenantId_sessionId: scope },
        data: { sandboxOrdinal: ordinal, leaseGeneration: { increment: 1 },
          encryptedToken: encryptSandboxSecret(token, this.options.encryptionKey), state: "active",
          lastActivityAt: now, updatedAt: now },
      });
      return prismaLeaseToLease(row, this.options.encryptionKey);
    });
  }

  async touch(scope: SandboxLeaseScope): Promise<void> {
    await this.ready();
    const now = new Date();
    await this.prisma.qaseySandboxLease.updateMany({
      where: { ...scope, state: "active" }, data: { lastActivityAt: now, updatedAt: now },
    });
  }

  async release(scope: SandboxLeaseScope): Promise<void> {
    await this.ready();
    await this.prisma.qaseySandboxLease.updateMany({
      where: scope, data: { state: "idle", updatedAt: new Date() },
    });
  }

  async close(): Promise<void> {}

  private ready(): Promise<void> {
    return this.initialized ?? Promise.reject(new Error("PrismaSandboxLeaseStore has not been initialized"));
  }
}

function selectOrdinal(
  leases: SandboxLease[],
  options: LeaseStoreOptions,
  preferred?: number,
  excluded = new Set<number>(),
): number {
  const counts = new Map<number, number>();
  for (const lease of leases) {
    if (lease.state === "active") counts.set(lease.ordinal, (counts.get(lease.ordinal) ?? 0) + 1);
  }
  return chooseOrdinal(counts, options, preferred, excluded);
}

function chooseOrdinal(
  counts: ReadonlyMap<number, number>,
  options: LeaseStoreOptions,
  preferred?: number,
  excluded = new Set<number>(),
): number {
  if (preferred !== undefined && !excluded.has(preferred) && preferred < options.replicas && (counts.get(preferred) ?? 0) < options.maxSessionsPerReplica) return preferred;
  const candidates = Array.from({ length: options.replicas }, (_, ordinal) => ({ ordinal, count: counts.get(ordinal) ?? 0 }))
    .filter(candidate => !excluded.has(candidate.ordinal) && candidate.count < options.maxSessionsPerReplica)
    .sort((left, right) => left.count - right.count || left.ordinal - right.ordinal);
  const selected = candidates[0];
  if (!selected) throw new SandboxCapacityError();
  return selected.ordinal;
}

function workspaceId(scope: SandboxLeaseScope): string {
  return createHash("sha256")
    .update(scope.applicationId).update("\0")
    .update(scope.tenantId).update("\0")
    .update(scope.sessionId)
    .digest("hex");
}

function leaseKey(scope: SandboxLeaseScope): string {
  return `${scope.applicationId}\0${scope.tenantId}\0${scope.sessionId}`;
}

function rowToLease(row: LeaseRow, encryptionKey: string, lastActivityAt = row.last_activity_at.toISOString()): SandboxLease {
  return {
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    ordinal: row.sandbox_ordinal,
    generation: row.lease_generation,
    token: decryptSandboxSecret(row.encrypted_token, encryptionKey),
    state: row.state,
    lastActivityAt,
  };
}

function prismaLeaseToLease(row: QaseySandboxLease, encryptionKey: string): SandboxLease {
  return {
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    ordinal: row.sandboxOrdinal,
    generation: row.leaseGeneration,
    token: decryptSandboxSecret(row.encryptedToken, encryptionKey),
    state: row.state as "active" | "idle",
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}
