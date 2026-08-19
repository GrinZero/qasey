import { Pool } from "pg";

export interface AuditRecord {
  requestId: string;
  tenantId?: string;
  subjectId?: string;
  applicationId?: string;
  resourceType: string;
  resourceId: string;
  action: string;
  decision: "allow" | "deny";
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLog {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  write(record: AuditRecord): Promise<void>;
  list?(tenantId: string, limit: number): Promise<readonly AuditRecord[]>;
  close?(): Promise<void>;
}

export class InMemoryAuditLog implements AuditLog {
  readonly records: AuditRecord[] = [];
  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}
  async write(record: AuditRecord): Promise<void> { this.records.push(structuredClone(record)); }
  async list(tenantId: string, limit: number): Promise<readonly AuditRecord[]> {
    return structuredClone(this.records.filter(record => record.tenantId === tenantId).slice(-limit).reverse());
  }
  async close(): Promise<void> {}
}

export class PostgresAuditLog implements AuditLog {
  private readonly pool: Pool;
  private initialized?: Promise<void>;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 3 }); }

  init(): Promise<void> {
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS platform_audit_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id text NOT NULL,
      tenant_id text,
      subject_id text,
      application_id text,
      resource_type text NOT NULL,
      resource_id text NOT NULL,
      action text NOT NULL,
      decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
      reason text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`).then(() => undefined);
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PostgresAuditLog has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.pool.query("SELECT 1");
  }

  async write(record: AuditRecord): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO platform_audit_log
       (request_id, tenant_id, subject_id, application_id, resource_type, resource_id, action, decision, reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [record.requestId, record.tenantId, record.subjectId, record.applicationId, record.resourceType,
        record.resourceId, record.action, record.decision, record.reason, JSON.stringify(record.metadata ?? {})],
    );
  }

  async list(tenantId: string, limit: number): Promise<readonly AuditRecord[]> {
    await this.ready();
    const result = await this.pool.query<{
      request_id: string; tenant_id?: string; subject_id?: string; application_id?: string;
      resource_type: string; resource_id: string; action: string; decision: "allow" | "deny"; reason: string; metadata: Record<string, unknown>;
    }>(`SELECT request_id, tenant_id, subject_id, application_id, resource_type, resource_id, action, decision, reason, metadata
        FROM platform_audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`, [tenantId, Math.min(Math.max(limit, 1), 500)]);
    return result.rows.map(row => ({
      requestId: row.request_id,
      ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
      ...(row.subject_id ? { subjectId: row.subject_id } : {}),
      ...(row.application_id ? { applicationId: row.application_id } : {}),
      resourceType: row.resource_type, resourceId: row.resource_id, action: row.action,
      decision: row.decision, reason: row.reason, metadata: row.metadata,
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}
