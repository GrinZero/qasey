import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
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

export class PostgresSandboxLeaseStore implements SandboxLeaseStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string, private readonly options: LeaseStoreOptions) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  init(): Promise<void> {
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS qasey_sandbox_leases (
      application_id text NOT NULL,
      tenant_id text NOT NULL,
      session_id text NOT NULL,
      workspace_id text NOT NULL,
      sandbox_ordinal integer NOT NULL,
      lease_generation integer NOT NULL,
      encrypted_token text NOT NULL,
      state text NOT NULL CHECK (state IN ('active', 'idle')),
      last_activity_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (application_id, tenant_id, session_id),
      CHECK (sandbox_ordinal >= 0),
      CHECK (lease_generation > 0)
    );
    CREATE INDEX IF NOT EXISTS qasey_sandbox_leases_capacity_idx
      ON qasey_sandbox_leases(state, sandbox_ordinal, last_activity_at);
    `).then(() => undefined);
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.pool.query("SELECT 1");
  }

  async acquire(scope: SandboxLeaseScope): Promise<SandboxLease> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('qasey-sandbox-capacity-v1'))");
      await client.query(
        "UPDATE qasey_sandbox_leases SET state = 'idle', updated_at = now() WHERE state = 'active' AND last_activity_at <= now() - ($1 * interval '1 millisecond')",
        [this.options.idleTtlMs],
      );
      const currentResult = await client.query<LeaseRow>(
        `SELECT * FROM qasey_sandbox_leases
         WHERE application_id = $1 AND tenant_id = $2 AND session_id = $3 FOR UPDATE`,
        [scope.applicationId, scope.tenantId, scope.sessionId],
      );
      const current = currentResult.rows[0];
      if (current?.state === "active") {
        await client.query(
          `UPDATE qasey_sandbox_leases SET last_activity_at = now(), updated_at = now()
           WHERE application_id = $1 AND tenant_id = $2 AND session_id = $3`,
          [scope.applicationId, scope.tenantId, scope.sessionId],
        );
        await client.query("COMMIT");
        return rowToLease(current, this.options.encryptionKey, new Date().toISOString());
      }
      const counts = await client.query<{ sandbox_ordinal: number; count: string }>(
        "SELECT sandbox_ordinal, count(*)::text AS count FROM qasey_sandbox_leases WHERE state = 'active' GROUP BY sandbox_ordinal",
      );
      const active = new Map(counts.rows.map(row => [row.sandbox_ordinal, Number(row.count)]));
      const ordinal = chooseOrdinal(active, this.options, current?.sandbox_ordinal);
      const token = randomBytes(32).toString("base64url");
      const generation = (current?.lease_generation ?? 0) + 1;
      const id = workspaceId(scope);
      const result = await client.query<LeaseRow>(
        `INSERT INTO qasey_sandbox_leases(
           application_id, tenant_id, session_id, workspace_id, sandbox_ordinal,
           lease_generation, encrypted_token, state, last_activity_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now(), now())
         ON CONFLICT(application_id, tenant_id, session_id) DO UPDATE SET
           workspace_id = EXCLUDED.workspace_id,
           sandbox_ordinal = EXCLUDED.sandbox_ordinal,
           lease_generation = EXCLUDED.lease_generation,
           encrypted_token = EXCLUDED.encrypted_token,
           state = 'active', last_activity_at = now(), updated_at = now()
         RETURNING *`,
        [scope.applicationId, scope.tenantId, scope.sessionId, id, ordinal, generation,
          encryptSandboxSecret(token, this.options.encryptionKey)],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Sandbox lease upsert returned no row");
      await client.query("COMMIT");
      return rowToLease(row, this.options.encryptionKey);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reassign(scope: SandboxLeaseScope, failedOrdinal: number): Promise<SandboxLease> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('qasey-sandbox-capacity-v1'))");
      await client.query(
        "UPDATE qasey_sandbox_leases SET state = 'idle', updated_at = now() WHERE state = 'active' AND last_activity_at <= now() - ($1 * interval '1 millisecond')",
        [this.options.idleTtlMs],
      );
      const currentResult = await client.query<LeaseRow>(
        `SELECT * FROM qasey_sandbox_leases
         WHERE application_id = $1 AND tenant_id = $2 AND session_id = $3 FOR UPDATE`,
        [scope.applicationId, scope.tenantId, scope.sessionId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new Error("Cannot reassign a sandbox lease that does not exist");
      const counts = await client.query<{ sandbox_ordinal: number; count: string }>(
        "SELECT sandbox_ordinal, count(*)::text AS count FROM qasey_sandbox_leases WHERE state = 'active' GROUP BY sandbox_ordinal",
      );
      const active = new Map(counts.rows.map(row => [row.sandbox_ordinal, Number(row.count)]));
      const ordinal = chooseOrdinal(active, this.options, undefined, new Set([failedOrdinal]));
      const token = randomBytes(32).toString("base64url");
      const result = await client.query<LeaseRow>(
        `UPDATE qasey_sandbox_leases SET
           sandbox_ordinal = $4, lease_generation = lease_generation + 1,
           encrypted_token = $5, state = 'active', last_activity_at = now(), updated_at = now()
         WHERE application_id = $1 AND tenant_id = $2 AND session_id = $3
         RETURNING *`,
        [scope.applicationId, scope.tenantId, scope.sessionId, ordinal,
          encryptSandboxSecret(token, this.options.encryptionKey)],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Sandbox lease reassignment returned no row");
      await client.query("COMMIT");
      return rowToLease(row, this.options.encryptionKey);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async touch(scope: SandboxLeaseScope): Promise<void> {
    await this.ready();
    await this.pool.query(
      `UPDATE qasey_sandbox_leases SET last_activity_at = now(), updated_at = now()
       WHERE application_id = $1 AND tenant_id = $2 AND session_id = $3 AND state = 'active'`,
      [scope.applicationId, scope.tenantId, scope.sessionId],
    );
  }

  async release(scope: SandboxLeaseScope): Promise<void> {
    await this.ready();
    await this.pool.query(
      `UPDATE qasey_sandbox_leases SET state = 'idle', updated_at = now()
       WHERE application_id = $1 AND tenant_id = $2 AND session_id = $3`,
      [scope.applicationId, scope.tenantId, scope.sessionId],
    );
  }

  async close(): Promise<void> { await this.pool.end(); }

  private ready(): Promise<void> {
    return this.initialized ?? Promise.reject(new Error("PostgresSandboxLeaseStore has not been initialized"));
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
