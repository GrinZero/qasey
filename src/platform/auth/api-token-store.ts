import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PlatformApiToken, PrismaClient } from "@prisma/client";
import { createServicePrincipal, OAuthPrincipalSchema, type OAuthPrincipal } from "./oauth-principal.ts";

const TOKEN_PATTERN = /^qsy_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/u;

export interface ApiTokenRecord {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  scopes: readonly string[];
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface StoredApiToken extends ApiTokenRecord {
  tokenHash: Buffer;
}

export interface CreateApiTokenInput {
  tenantId: string;
  name: string;
  scopes: readonly string[];
  createdBy: string;
  expiresAt?: string;
}

export interface CreatedApiToken {
  token: string;
  record: ApiTokenRecord;
}

export type ApiTokenUsePolicy = (record: ApiTokenRecord) => boolean | Promise<boolean>;

export interface ApiTokenStore {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  create(input: CreateApiTokenInput): Promise<CreatedApiToken>;
  list(tenantId: string): Promise<readonly ApiTokenRecord[]>;
  revoke(tenantId: string, id: string): Promise<boolean>;
  revokeByCreator(tenantId: string, createdBy: string): Promise<number>;
  authenticate(token: string): Promise<OAuthPrincipal | undefined>;
  close?(): Promise<void>;
}

export class InMemoryApiTokenStore implements ApiTokenStore {
  private readonly records = new Map<string, StoredApiToken>();

  constructor(private readonly authorizeUse: ApiTokenUsePolicy = () => true) {}

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async create(input: CreateApiTokenInput): Promise<CreatedApiToken> {
    const created = createToken(input);
    this.records.set(created.record.id, { ...created.record, tokenHash: tokenHash(created.token) });
    return created;
  }

  async list(tenantId: string): Promise<readonly ApiTokenRecord[]> {
    return [...this.records.values()]
      .filter(record => record.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicRecord);
  }

  async revoke(tenantId: string, id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.tenantId !== tenantId || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    return true;
  }

  async revokeByCreator(tenantId: string, createdBy: string): Promise<number> {
    const revokedAt = new Date().toISOString();
    let count = 0;
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.createdBy === createdBy && !record.revokedAt) {
        record.revokedAt = revokedAt;
        count += 1;
      }
    }
    return count;
  }

  async authenticate(token: string): Promise<OAuthPrincipal | undefined> {
    const id = tokenId(token);
    const record = id ? this.records.get(id) : undefined;
    if (!record || !isUsable(record) || !tokensEqual(record.tokenHash, tokenHash(token))) return undefined;
    if (!await this.authorizeUse(publicRecord(record))) return undefined;
    record.lastUsedAt = new Date().toISOString();
    return tokenPrincipal(record);
  }

  async close(): Promise<void> {}
}

export class PrismaApiTokenStore implements ApiTokenStore {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient, private readonly authorizeUse: ApiTokenUsePolicy = () => true) {}

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaApiTokenStore has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async create(input: CreateApiTokenInput): Promise<CreatedApiToken> {
    await this.ready();
    const created = createToken(input);
    await this.prisma.platformApiToken.create({ data: {
      id: created.record.id,
      tenantId: created.record.tenantId,
      name: created.record.name,
      tokenPrefix: created.record.prefix,
      tokenHash: Uint8Array.from(tokenHash(created.token)),
      scopes: [...created.record.scopes],
      createdBy: created.record.createdBy,
      createdAt: new Date(created.record.createdAt),
      expiresAt: created.record.expiresAt ? new Date(created.record.expiresAt) : null,
    } });
    return created;
  }

  async list(tenantId: string): Promise<readonly ApiTokenRecord[]> {
    await this.ready();
    const records = await this.prisma.platformApiToken.findMany({
      where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100,
    });
    return records.map(rowToRecord);
  }

  async revoke(tenantId: string, id: string): Promise<boolean> {
    await this.ready();
    const result = await this.prisma.platformApiToken.updateMany({
      where: { tenantId, id, revokedAt: null }, data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  async revokeByCreator(tenantId: string, createdBy: string): Promise<number> {
    await this.ready();
    const result = await this.prisma.platformApiToken.updateMany({
      where: { tenantId, createdBy, revokedAt: null }, data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async authenticate(token: string): Promise<OAuthPrincipal | undefined> {
    const id = tokenId(token);
    if (!id) return undefined;
    await this.ready();
    const row = await this.prisma.platformApiToken.findUnique({ where: { id } });
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      || !tokensEqual(Buffer.from(row.tokenHash), tokenHash(token))) return undefined;
    const record = rowToRecord(row);
    if (!await this.authorizeUse(record)) return undefined;
    await this.prisma.platformApiToken.update({ where: { id }, data: { lastUsedAt: new Date() } });
    return tokenPrincipal(record);
  }

  async close(): Promise<void> {}
}

function createToken(input: CreateApiTokenInput): CreatedApiToken {
  const id = randomUUID();
  const token = `qsy_${id}_${randomBytes(32).toString("base64url")}`;
  const record: ApiTokenRecord = {
    id,
    tenantId: input.tenantId,
    name: input.name,
    prefix: `qsy_${id.slice(0, 8)}`,
    scopes: [...new Set(input.scopes)].sort(),
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  return { token, record };
}

function tokenId(token: string): string | undefined {
  return TOKEN_PATTERN.exec(token)?.[1];
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function tokensEqual(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isUsable(record: ApiTokenRecord): boolean {
  return !record.revokedAt && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now());
}

function tokenPrincipal(record: ApiTokenRecord): OAuthPrincipal {
  return OAuthPrincipalSchema.parse({
    ...createServicePrincipal({ subjectId: `api-token:${record.id}`, tenantId: record.tenantId, roles: [] }),
    audience: "api",
    scopes: [...record.scopes],
    tokenId: record.id,
  });
}

function publicRecord(record: StoredApiToken): ApiTokenRecord {
  const { tokenHash: _, ...visible } = record;
  return structuredClone(visible);
}

function rowToRecord(row: PlatformApiToken): ApiTokenRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    prefix: row.tokenPrefix,
    scopes: [...row.scopes],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  };
}
