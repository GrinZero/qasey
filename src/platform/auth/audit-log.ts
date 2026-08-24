import { Prisma, type PrismaClient } from "@prisma/client";

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

export class PrismaAuditLog implements AuditLog {
  private initialized?: Promise<void>;
  constructor(private readonly prisma: PrismaClient) {}

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaAuditLog has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async write(record: AuditRecord): Promise<void> {
    await this.ready();
    await this.prisma.platformAuditLog.create({ data: {
      requestId: record.requestId,
      tenantId: record.tenantId ?? null,
      subjectId: record.subjectId ?? null,
      applicationId: record.applicationId ?? null,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      action: record.action,
      decision: record.decision,
      reason: record.reason,
      metadata: (record.metadata ?? {}) as Prisma.InputJsonValue,
    } });
  }

  async list(tenantId: string, limit: number): Promise<readonly AuditRecord[]> {
    await this.ready();
    const records = await this.prisma.platformAuditLog.findMany({
      where: { tenantId }, orderBy: { id: "desc" }, take: Math.min(Math.max(limit, 1), 500),
    });
    return records.map(row => ({
      requestId: row.requestId,
      ...(row.tenantId ? { tenantId: row.tenantId } : {}),
      ...(row.subjectId ? { subjectId: row.subjectId } : {}),
      ...(row.applicationId ? { applicationId: row.applicationId } : {}),
      resourceType: row.resourceType, resourceId: row.resourceId, action: row.action,
      decision: row.decision as "allow" | "deny", reason: row.reason, metadata: row.metadata as Record<string, unknown>,
    }));
  }

  async close(): Promise<void> {}
}
