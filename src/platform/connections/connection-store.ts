import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type ExternalConnectionProvider = "slack" | "jira" | "github" | "mcp";
export type ExternalConnectionStatus = "active" | "disabled" | "revoked";

export interface ExternalConnection {
  id: string;
  tenantId: string;
  provider: ExternalConnectionProvider;
  name: string;
  configuration: Readonly<Record<string, unknown>>;
  status: ExternalConnectionStatus;
  revision: number;
  credentialKeyId: string;
  credentialFingerprint: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface RuntimeExternalConnection extends ExternalConnection {
  credentials: Readonly<Record<string, string>>;
}

export interface CredentialKeyring {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
}

export interface CreateExternalConnectionInput {
  tenantId: string;
  provider: ExternalConnectionProvider;
  name: string;
  configuration?: Readonly<Record<string, unknown>>;
  credentials: Readonly<Record<string, string>>;
  actorId: string;
}

export interface UpdateExternalConnectionInput {
  tenantId: string;
  id: string;
  expectedRevision: number;
  configuration?: Readonly<Record<string, unknown>>;
  credentials?: Readonly<Record<string, string>>;
  status?: Exclude<ExternalConnectionStatus, "revoked">;
  actorId: string;
}

export class ExternalConnectionStoreError extends Error {
  constructor(
    readonly code: "not_found" | "duplicate" | "revision_conflict" | "invalid_configuration" | "invalid_credentials" | "key_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ExternalConnectionStoreError";
  }
}

export interface ExternalConnectionStore {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  list(tenantId: string, provider?: ExternalConnectionProvider): Promise<readonly ExternalConnection[]>;
  get(tenantId: string, id: string): Promise<ExternalConnection | undefined>;
  getRuntime(tenantId: string, id: string): Promise<RuntimeExternalConnection | undefined>;
  findActive(tenantId: string, provider: ExternalConnectionProvider): Promise<readonly RuntimeExternalConnection[]>;
  create(input: CreateExternalConnectionInput): Promise<ExternalConnection>;
  update(input: UpdateExternalConnectionInput): Promise<ExternalConnection>;
  rotate(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<ExternalConnection>;
  revoke(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<ExternalConnection>;
  close?(): Promise<void>;
}

interface StoredExternalConnection extends ExternalConnection {
  credentialsCiphertext: string;
}

export class InMemoryExternalConnectionStore implements ExternalConnectionStore {
  private readonly records = new Map<string, StoredExternalConnection>();

  constructor(private readonly keyring: CredentialKeyring, private readonly now: () => Date = () => new Date()) {
    validateKeyring(keyring);
  }

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async list(tenantId: string, provider?: ExternalConnectionProvider): Promise<readonly ExternalConnection[]> {
    return [...this.records.values()]
      .filter(record => record.tenantId === tenantId && (!provider || record.provider === provider))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicConnection);
  }

  async get(tenantId: string, id: string): Promise<ExternalConnection | undefined> {
    const record = this.records.get(id);
    return record?.tenantId === tenantId ? publicConnection(record) : undefined;
  }

  async getRuntime(tenantId: string, id: string): Promise<RuntimeExternalConnection | undefined> {
    const record = this.records.get(id);
    return record?.tenantId === tenantId ? runtimeConnection(record, this.keyring) : undefined;
  }

  async findActive(tenantId: string, provider: ExternalConnectionProvider): Promise<readonly RuntimeExternalConnection[]> {
    return [...this.records.values()]
      .filter(record => record.tenantId === tenantId && record.provider === provider && record.status === "active")
      .map(record => runtimeConnection(record, this.keyring));
  }

  async create(input: CreateExternalConnectionInput): Promise<ExternalConnection> {
    validateConnectionInput(input);
    if ([...this.records.values()].some(record =>
      record.tenantId === input.tenantId && record.provider === input.provider && record.name === input.name)) {
      throw new ExternalConnectionStoreError("duplicate", "An external connection with this provider and name already exists");
    }
    const id = randomUUID();
    const now = this.now().toISOString();
    const encrypted = encryptCredentials(input.credentials, this.keyring, input.tenantId, id, input.provider);
    const record: StoredExternalConnection = {
      id,
      tenantId: input.tenantId,
      provider: input.provider,
      name: input.name.trim(),
      configuration: structuredClone(input.configuration ?? {}),
      status: "active",
      revision: 1,
      credentialKeyId: encrypted.keyId,
      credentialFingerprint: credentialFingerprint(input.credentials, credentialKey(this.keyring, encrypted.keyId)),
      credentialsCiphertext: encrypted.ciphertext,
      createdBy: input.actorId,
      updatedBy: input.actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    return publicConnection(record);
  }

  async update(input: UpdateExternalConnectionInput): Promise<ExternalConnection> {
    const record = this.require(input.tenantId, input.id, input.expectedRevision);
    if (record.status === "revoked") throw new ExternalConnectionStoreError("not_found", "External connection was not found");
    if (input.configuration !== undefined) {
      validateConfiguration(input.configuration);
      record.configuration = structuredClone(input.configuration);
    }
    if (input.credentials !== undefined) {
      validateCredentials(input.credentials);
      const encrypted = encryptCredentials(input.credentials, this.keyring, record.tenantId, record.id, record.provider);
      record.credentialsCiphertext = encrypted.ciphertext;
      record.credentialKeyId = encrypted.keyId;
      record.credentialFingerprint = credentialFingerprint(input.credentials, credentialKey(this.keyring, encrypted.keyId));
    }
    if (input.status !== undefined) record.status = input.status;
    record.updatedBy = input.actorId;
    bump(record, this.now());
    return publicConnection(record);
  }

  async rotate(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<ExternalConnection> {
    const record = this.require(tenantId, id, expectedRevision);
    const credentials = decryptCredentials(record, this.keyring);
    const encrypted = encryptCredentials(credentials, this.keyring, record.tenantId, record.id, record.provider);
    record.credentialsCiphertext = encrypted.ciphertext;
    record.credentialKeyId = encrypted.keyId;
    record.credentialFingerprint = credentialFingerprint(credentials, credentialKey(this.keyring, encrypted.keyId));
    record.updatedBy = actorId;
    bump(record, this.now());
    return publicConnection(record);
  }

  async revoke(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<ExternalConnection> {
    const record = this.require(tenantId, id, expectedRevision);
    record.status = "revoked";
    record.revokedAt = this.now().toISOString();
    record.updatedBy = actorId;
    bump(record, this.now());
    return publicConnection(record);
  }

  async close(): Promise<void> { this.records.clear(); }

  private require(tenantId: string, id: string, expectedRevision: number): StoredExternalConnection {
    const record = this.records.get(id);
    if (!record || record.tenantId !== tenantId) throw new ExternalConnectionStoreError("not_found", "External connection was not found");
    if (record.revision !== expectedRevision) throw new ExternalConnectionStoreError("revision_conflict", "External connection changed; reload and retry");
    return record;
  }
}

interface ExternalConnectionRow {
  id: string;
  tenant_id: string;
  provider: ExternalConnectionProvider;
  name: string;
  configuration: Record<string, unknown>;
  credentials_ciphertext: string;
  credential_key_id: string;
  credential_fingerprint: string;
  status: ExternalConnectionStatus;
  revision: bigint | number | string;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

export class PrismaExternalConnectionStore implements ExternalConnectionStore {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient, private readonly keyring: CredentialKeyring) {
    validateKeyring(keyring);
  }

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    return this.initialized ?? Promise.reject(new Error("PrismaExternalConnectionStore has not been initialized"));
  }

  async healthCheck(): Promise<void> { await this.ready(); await this.prisma.$queryRaw`SELECT 1`; }

  async list(tenantId: string, provider?: ExternalConnectionProvider): Promise<readonly ExternalConnection[]> {
    await this.ready();
    const rows = provider
      ? await this.prisma.$queryRawUnsafe<ExternalConnectionRow[]>(`${SELECT_CONNECTION} WHERE tenant_id=$1 AND provider=$2 ORDER BY created_at DESC`, tenantId, provider)
      : await this.prisma.$queryRawUnsafe<ExternalConnectionRow[]>(`${SELECT_CONNECTION} WHERE tenant_id=$1 ORDER BY created_at DESC`, tenantId);
    return rows.map(row => publicConnection(rowToStored(row)));
  }

  async get(tenantId: string, id: string): Promise<ExternalConnection | undefined> {
    const record = await this.getStored(tenantId, id);
    return record ? publicConnection(record) : undefined;
  }

  async getRuntime(tenantId: string, id: string): Promise<RuntimeExternalConnection | undefined> {
    const record = await this.getStored(tenantId, id);
    return record ? runtimeConnection(record, this.keyring) : undefined;
  }

  async findActive(tenantId: string, provider: ExternalConnectionProvider): Promise<readonly RuntimeExternalConnection[]> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<ExternalConnectionRow[]>(
      `${SELECT_CONNECTION} WHERE tenant_id=$1 AND provider=$2 AND status='active' ORDER BY created_at`, tenantId, provider,
    );
    return rows.map(row => runtimeConnection(rowToStored(row), this.keyring));
  }

  async create(input: CreateExternalConnectionInput): Promise<ExternalConnection> {
    await this.ready();
    validateConnectionInput(input);
    const id = randomUUID();
    const encrypted = encryptCredentials(input.credentials, this.keyring, input.tenantId, id, input.provider);
    try {
      const rows = await this.prisma.$queryRawUnsafe<ExternalConnectionRow[]>(
        `INSERT INTO platform_external_connections
          (id,tenant_id,provider,name,configuration,credentials_ciphertext,credential_key_id,credential_fingerprint,status,revision,created_by,updated_by)
         VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,$8,'active',1,$9,$9)
         RETURNING *`,
        id, input.tenantId, input.provider, input.name.trim(), JSON.stringify(input.configuration ?? {}), encrypted.ciphertext,
        encrypted.keyId, credentialFingerprint(input.credentials, credentialKey(this.keyring, encrypted.keyId)), input.actorId,
      );
      return publicConnection(rowToStored(rows[0]!));
    } catch (error) {
      if (postgresCode(error) === "23505") throw new ExternalConnectionStoreError("duplicate", "An external connection with this provider and name already exists");
      throw error;
    }
  }

  async update(input: UpdateExternalConnectionInput): Promise<ExternalConnection> {
    await this.ready();
    const current = await this.requireRevision(input.tenantId, input.id, input.expectedRevision);
    if (current.status === "revoked") throw new ExternalConnectionStoreError("not_found", "External connection was not found");
    if (input.configuration !== undefined) validateConfiguration(input.configuration);
    const credentials = input.credentials ?? decryptCredentials(current, this.keyring);
    validateCredentials(credentials);
    const encrypted = input.credentials
      ? encryptCredentials(credentials, this.keyring, current.tenantId, current.id, current.provider)
      : { ciphertext: current.credentialsCiphertext, keyId: current.credentialKeyId };
    const rows = await this.prisma.$queryRawUnsafe<ExternalConnectionRow[]>(
      `UPDATE platform_external_connections SET
         configuration=$4::jsonb,credentials_ciphertext=$5,credential_key_id=$6,credential_fingerprint=$7,
         status=$8,revision=revision+1,updated_by=$9,updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid AND revision=$3 RETURNING *`,
      input.tenantId, input.id, input.expectedRevision, JSON.stringify(input.configuration ?? current.configuration),
      encrypted.ciphertext, encrypted.keyId, credentialFingerprint(credentials, credentialKey(this.keyring, encrypted.keyId)),
      input.status ?? current.status, input.actorId,
    );
    if (!rows[0]) throw new ExternalConnectionStoreError("revision_conflict", "External connection changed; reload and retry");
    return publicConnection(rowToStored(rows[0]));
  }

  async rotate(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<ExternalConnection> {
    const current = await this.requireRevision(tenantId, id, expectedRevision);
    return this.update({
      tenantId,
      id,
      expectedRevision,
      credentials: decryptCredentials(current, this.keyring),
      actorId,
    });
  }

  async revoke(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<ExternalConnection> {
    await this.ready();
    await this.requireRevision(tenantId, id, expectedRevision);
    const rows = await this.prisma.$queryRawUnsafe<ExternalConnectionRow[]>(
      `UPDATE platform_external_connections SET status='revoked',revoked_at=now(),revision=revision+1,updated_by=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid AND revision=$3 RETURNING *`,
      tenantId, id, expectedRevision, actorId,
    );
    if (!rows[0]) throw new ExternalConnectionStoreError("revision_conflict", "External connection changed; reload and retry");
    return publicConnection(rowToStored(rows[0]));
  }

  async close(): Promise<void> {}

  private async getStored(tenantId: string, id: string): Promise<StoredExternalConnection | undefined> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<ExternalConnectionRow[]>(`${SELECT_CONNECTION} WHERE tenant_id=$1 AND id=$2::uuid`, tenantId, id);
    return rows[0] ? rowToStored(rows[0]) : undefined;
  }

  private async requireRevision(tenantId: string, id: string, expectedRevision: number): Promise<StoredExternalConnection> {
    const current = await this.getStored(tenantId, id);
    if (!current) throw new ExternalConnectionStoreError("not_found", "External connection was not found");
    if (current.revision !== expectedRevision) throw new ExternalConnectionStoreError("revision_conflict", "External connection changed; reload and retry");
    return current;
  }
}

const SELECT_CONNECTION = `SELECT id,tenant_id,provider,name,configuration,credentials_ciphertext,credential_key_id,
credential_fingerprint,status,revision,created_by,updated_by,created_at,updated_at,revoked_at FROM platform_external_connections`;

function validateConnectionInput(input: CreateExternalConnectionInput): void {
  if (!input.tenantId.trim() || !input.name.trim() || !input.actorId.trim()) {
    throw new Error("External connection tenant, name and actor are required");
  }
  validateConfiguration(input.configuration ?? {});
  validateCredentials(input.credentials);
}

function validateConfiguration(configuration: Readonly<Record<string, unknown>>): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(configuration); } catch {
    throw new ExternalConnectionStoreError("invalid_configuration", "External connection configuration must be JSON serializable");
  }
  if (encoded === undefined) {
    throw new ExternalConnectionStoreError("invalid_configuration", "External connection configuration must be JSON serializable");
  }
  if (encoded.length > 64 * 1024) {
    throw new ExternalConnectionStoreError("invalid_configuration", "External connection configuration is too large");
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:authorization|cookie|credential|pass(?:word)?|secret|token|api[_-]?key|private[_-]?key)/iu.test(key)) {
        throw new ExternalConnectionStoreError(
          "invalid_configuration",
          "Secrets belong in the encrypted credentials payload, not public configuration",
        );
      }
      visit(child);
    }
  };
  visit(configuration);
}

function validateCredentials(credentials: Readonly<Record<string, string>>): void {
  const entries = Object.entries(credentials);
  if (entries.length === 0 || entries.some(([key, value]) => !key.trim() || !value.trim())) {
    throw new ExternalConnectionStoreError("invalid_credentials", "External connection credentials must contain non-empty values");
  }
}

function validateKeyring(keyring: CredentialKeyring): void {
  const entries = Object.entries(keyring.keys);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(keyring.activeKeyId)
    || !Object.hasOwn(keyring.keys, keyring.activeKeyId)) {
    throw new Error("Credential keyring active key is unavailable");
  }
  if (entries.length === 0 || entries.length > 16) throw new Error("Credential keyring size is invalid");
  for (const [keyId, key] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(keyId) || Buffer.byteLength(key, "utf8") < 32) {
      throw new Error("Credential keyring contains an invalid key");
    }
  }
  if (new Set(entries.map(([, key]) => key)).size !== entries.length) {
    throw new Error("Credential keyring contains duplicate key material");
  }
}

function credentialKey(keyring: CredentialKeyring, keyId: string): string {
  const key = Object.hasOwn(keyring.keys, keyId) ? keyring.keys[keyId] : undefined;
  if (!key) throw new ExternalConnectionStoreError("key_unavailable", "External connection credential key is unavailable");
  return key;
}

function encryptCredentials(
  credentials: Readonly<Record<string, string>>,
  keyring: CredentialKeyring,
  tenantId: string,
  connectionId: string,
  provider: ExternalConnectionProvider,
): { ciphertext: string; keyId: string } {
  validateCredentials(credentials);
  const keyId = keyring.activeKeyId;
  const key = credentialKey(keyring, keyId);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key), nonce);
  cipher.setAAD(connectionAad(tenantId, connectionId, provider));
  const plaintext = Buffer.from(JSON.stringify(sortRecord(credentials)), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    keyId,
    ciphertext: ["v1", keyId, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join("."),
  };
}

function decryptCredentials(record: StoredExternalConnection, keyring: CredentialKeyring): Readonly<Record<string, string>> {
  const [version, keyId, nonce, tag, encrypted] = record.credentialsCiphertext.split(".");
  if (version !== "v1" || !keyId || keyId !== record.credentialKeyId || !nonce || !tag || !encrypted) {
    throw new ExternalConnectionStoreError("invalid_credentials", "External connection credentials could not be decrypted");
  }
  if (!Object.hasOwn(keyring.keys, keyId)) {
    throw new ExternalConnectionStoreError("key_unavailable", "External connection credential key is unavailable");
  }
  const key = credentialKey(keyring, keyId);
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(key), Buffer.from(nonce, "base64url"));
    decipher.setAAD(connectionAad(record.tenantId, record.id, record.provider));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const parsed = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8")) as Record<string, unknown>;
    if (Object.values(parsed).some(value => typeof value !== "string")) throw new Error("invalid credential payload");
    return parsed as Record<string, string>;
  } catch (error) {
    if (error instanceof ExternalConnectionStoreError) throw error;
    throw new ExternalConnectionStoreError("invalid_credentials", "External connection credentials could not be decrypted");
  }
}

function deriveKey(value: string): Buffer { return createHash("sha256").update(value).digest(); }

function connectionAad(tenantId: string, connectionId: string, provider: string): Buffer {
  return Buffer.from(["qasey-external-connection", tenantId, connectionId, provider].join("\0"), "utf8");
}

function credentialFingerprint(credentials: Readonly<Record<string, string>>, key: string): string {
  return createHmac("sha256", deriveKey(key)).update(JSON.stringify(sortRecord(credentials))).digest("hex").slice(0, 24);
}

function sortRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function publicConnection(record: StoredExternalConnection): ExternalConnection {
  const { credentialsCiphertext: _credentialsCiphertext, ...safe } = record;
  return structuredClone(safe);
}

function runtimeConnection(record: StoredExternalConnection, keyring: CredentialKeyring): RuntimeExternalConnection {
  return { ...publicConnection(record), credentials: decryptCredentials(record, keyring) };
}

function rowToStored(row: ExternalConnectionRow): StoredExternalConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    name: row.name,
    configuration: structuredClone(row.configuration),
    credentialsCiphertext: row.credentials_ciphertext,
    credentialKeyId: row.credential_key_id,
    credentialFingerprint: row.credential_fingerprint,
    status: row.status,
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
  };
}

function bump(record: StoredExternalConnection, now: Date): void {
  record.revision += 1;
  record.updatedAt = now.toISOString();
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
