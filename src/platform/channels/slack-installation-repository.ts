import { createHmac, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decryptSlackCredential, encryptSlackCredential } from "./slack-credentials.ts";
import { DEFAULT_SLACK_DEV_RUNTIME_COMMAND } from "./slack-dev-runtime.ts";

export type SlackInstallationStatus = "awaiting_webhook" | "active" | "disabled" | "error";

export interface SlackInstallationIdentity {
  appId: string;
  appName?: string;
  teamId: string;
  teamName?: string;
  botUserId: string;
  botId?: string;
  enterpriseInstall?: boolean;
}

export interface SlackInstallation {
  id: string;
  tenantId: string;
  webhookId: string;
  displayName: string;
  identity: SlackInstallationIdentity;
  agentId: string;
  devRuntimeEnabled: boolean;
  devRuntimeCommand: string;
  status: SlackInstallationStatus;
  revision: number;
  credentialKeyId: string;
  webhookVerifiedAt?: string;
  lastTokenVerifiedAt: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackRuntimeInstallation extends SlackInstallation {
  botToken: string;
  signingSecret: string;
}

export interface CreateSlackInstallationInput {
  tenantId: string;
  displayName: string;
  agentId: string;
  identity: SlackInstallationIdentity;
  botToken: string;
  signingSecret: string;
  actorId: string;
  devRuntimeEnabled?: boolean;
  devRuntimeCommand?: string;
}

export interface UpdateSlackCredentialsInput {
  tenantId: string;
  id: string;
  expectedRevision: number;
  identity: SlackInstallationIdentity;
  botToken: string;
  signingSecret: string;
  actorId: string;
  devRuntimeEnabled?: boolean;
  devRuntimeCommand?: string;
}

export class SlackInstallationRepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "duplicate" | "revision_conflict" | "key_unavailable" | "invalid_credentials",
    message: string,
  ) {
    super(message);
  }
}

export interface SlackInstallationRepository {
  init?(): Promise<void>;
  healthCheck?(): Promise<void>;
  list(tenantId: string): Promise<readonly SlackInstallation[]>;
  get(tenantId: string, id: string): Promise<SlackInstallation | undefined>;
  getRuntimeByWebhookId(webhookId: string): Promise<SlackRuntimeInstallation | undefined>;
  create(input: CreateSlackInstallationInput): Promise<SlackInstallation>;
  updateCredentials(input: UpdateSlackCredentialsInput): Promise<SlackInstallation>;
  rotateCredentials(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<SlackInstallation>;
  setDevRuntimeConfiguration(
    tenantId: string,
    id: string,
    configuration: { enabled?: boolean; command?: string },
    expectedRevision: number,
    actorId: string,
  ): Promise<SlackInstallation>;
  rebind(tenantId: string, id: string, agentId: string, expectedRevision: number, actorId: string): Promise<SlackInstallation>;
  setEnabled(tenantId: string, id: string, enabled: boolean, expectedRevision: number, actorId: string): Promise<SlackInstallation>;
  markWebhookVerified(webhookId: string): Promise<SlackInstallation | undefined>;
  markError(webhookId: string, code: string): Promise<void>;
  delete(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<void>;
  close?(): Promise<void>;
}

interface StoredInstallation extends SlackInstallation {
  botTokenCiphertext: string;
  signingSecretCiphertext: string;
  credentialFingerprint: string;
}

export interface SlackCredentialKeyring {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
}

export class InMemorySlackInstallationRepository implements SlackInstallationRepository {
  private readonly records = new Map<string, StoredInstallation>();
  private readonly keyring: SlackCredentialKeyring;

  constructor(keyring: string | SlackCredentialKeyring) {
    this.keyring = normalizeSlackKeyring(keyring);
  }

  async init(): Promise<void> {}
  async healthCheck(): Promise<void> {}

  async list(tenantId: string): Promise<readonly SlackInstallation[]> {
    return [...this.records.values()]
      .filter(record => record.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicInstallation);
  }

  async get(tenantId: string, id: string): Promise<SlackInstallation | undefined> {
    const record = this.records.get(id);
    return record?.tenantId === tenantId ? publicInstallation(record) : undefined;
  }

  async getRuntimeByWebhookId(webhookId: string): Promise<SlackRuntimeInstallation | undefined> {
    const record = [...this.records.values()].find(candidate => candidate.webhookId === webhookId);
    return record ? runtimeInstallation(record, this.keyring) : undefined;
  }

  async create(input: CreateSlackInstallationInput): Promise<SlackInstallation> {
    if ([...this.records.values()].some(record => sameSlackInstallation(record.identity, input.identity))) {
      throw new SlackInstallationRepositoryError("duplicate", "This Slack App installation is already managed");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: StoredInstallation = {
      id,
      tenantId: input.tenantId,
      webhookId: randomUUID(),
      displayName: input.displayName,
      identity: structuredClone(input.identity),
      agentId: input.agentId,
      devRuntimeEnabled: input.devRuntimeEnabled ?? false,
      devRuntimeCommand: input.devRuntimeCommand ?? DEFAULT_SLACK_DEV_RUNTIME_COMMAND,
      status: "awaiting_webhook",
      revision: 1,
      credentialKeyId: this.keyring.activeKeyId,
      lastTokenVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
      botTokenCiphertext: encryptSlackCredential(input.botToken, activeSlackKey(this.keyring), {
        tenantId: input.tenantId, installationId: id, field: "bot-token",
      }, this.keyring.activeKeyId),
      signingSecretCiphertext: encryptSlackCredential(input.signingSecret, activeSlackKey(this.keyring), {
        tenantId: input.tenantId, installationId: id, field: "signing-secret",
      }, this.keyring.activeKeyId),
      credentialFingerprint: fingerprint(input.botToken, activeSlackKey(this.keyring)),
    };
    this.records.set(id, record);
    return publicInstallation(record);
  }

  async updateCredentials(input: UpdateSlackCredentialsInput): Promise<SlackInstallation> {
    const record = this.require(input.tenantId, input.id, input.expectedRevision);
    const duplicate = [...this.records.values()].find(candidate =>
      candidate.id !== input.id && sameSlackInstallation(candidate.identity, input.identity));
    if (duplicate) throw new SlackInstallationRepositoryError("duplicate", "This Slack App installation is already managed");
    record.identity = structuredClone(input.identity);
    record.botTokenCiphertext = encryptSlackCredential(input.botToken, activeSlackKey(this.keyring), {
      tenantId: input.tenantId, installationId: input.id, field: "bot-token",
    }, this.keyring.activeKeyId);
    record.signingSecretCiphertext = encryptSlackCredential(input.signingSecret, activeSlackKey(this.keyring), {
      tenantId: input.tenantId, installationId: input.id, field: "signing-secret",
    }, this.keyring.activeKeyId);
    record.credentialKeyId = this.keyring.activeKeyId;
    record.credentialFingerprint = fingerprint(input.botToken, activeSlackKey(this.keyring));
    if (input.devRuntimeEnabled !== undefined) record.devRuntimeEnabled = input.devRuntimeEnabled;
    if (input.devRuntimeCommand !== undefined) record.devRuntimeCommand = input.devRuntimeCommand;
    record.status = "awaiting_webhook";
    delete record.webhookVerifiedAt;
    record.lastTokenVerifiedAt = new Date().toISOString();
    delete record.lastErrorCode;
    bump(record);
    return publicInstallation(record);
  }

  async rotateCredentials(
    tenantId: string,
    id: string,
    expectedRevision: number,
    actorId: string,
  ): Promise<SlackInstallation> {
    const record = this.require(tenantId, id, expectedRevision);
    const credentials = decryptStoredSlackCredentials(record, this.keyring);
    const activeKey = activeSlackKey(this.keyring);
    record.botTokenCiphertext = encryptSlackCredential(credentials.botToken, activeKey, {
      tenantId, installationId: id, field: "bot-token",
    }, this.keyring.activeKeyId);
    record.signingSecretCiphertext = encryptSlackCredential(credentials.signingSecret, activeKey, {
      tenantId, installationId: id, field: "signing-secret",
    }, this.keyring.activeKeyId);
    record.credentialKeyId = this.keyring.activeKeyId;
    record.credentialFingerprint = fingerprint(credentials.botToken, activeKey);
    void actorId;
    bump(record);
    return publicInstallation(record);
  }

  async rebind(tenantId: string, id: string, agentId: string, expectedRevision: number, _actorId: string): Promise<SlackInstallation> {
    const record = this.require(tenantId, id, expectedRevision);
    record.agentId = agentId;
    bump(record);
    return publicInstallation(record);
  }

  async setDevRuntimeConfiguration(
    tenantId: string,
    id: string,
    configuration: { enabled?: boolean; command?: string },
    expectedRevision: number,
    _actorId: string,
  ): Promise<SlackInstallation> {
    const record = this.require(tenantId, id, expectedRevision);
    if (configuration.enabled !== undefined) record.devRuntimeEnabled = configuration.enabled;
    if (configuration.command !== undefined) record.devRuntimeCommand = configuration.command;
    bump(record);
    return publicInstallation(record);
  }

  async setEnabled(tenantId: string, id: string, enabled: boolean, expectedRevision: number, _actorId: string): Promise<SlackInstallation> {
    const record = this.require(tenantId, id, expectedRevision);
    record.status = enabled ? record.webhookVerifiedAt ? "active" : "awaiting_webhook" : "disabled";
    delete record.lastErrorCode;
    bump(record);
    return publicInstallation(record);
  }

  async markWebhookVerified(webhookId: string): Promise<SlackInstallation | undefined> {
    const record = [...this.records.values()].find(candidate => candidate.webhookId === webhookId);
    if (!record) return undefined;
    record.webhookVerifiedAt = new Date().toISOString();
    if (record.status !== "disabled") record.status = "active";
    delete record.lastErrorCode;
    bump(record);
    return publicInstallation(record);
  }

  async markError(webhookId: string, code: string): Promise<void> {
    const record = [...this.records.values()].find(candidate => candidate.webhookId === webhookId);
    if (!record || record.status === "disabled") return;
    record.status = "error";
    record.lastErrorCode = code;
    bump(record);
  }

  async delete(tenantId: string, id: string, expectedRevision: number, _actorId: string): Promise<void> {
    this.require(tenantId, id, expectedRevision);
    this.records.delete(id);
  }

  async close(): Promise<void> { this.records.clear(); }

  private require(tenantId: string, id: string, expectedRevision: number): StoredInstallation {
    const record = this.records.get(id);
    if (!record || record.tenantId !== tenantId) throw new SlackInstallationRepositoryError("not_found", "Slack App connection was not found");
    if (record.revision !== expectedRevision) throw new SlackInstallationRepositoryError("revision_conflict", "Slack App connection changed; reload and try again");
    return record;
  }
}

interface InstallationRow {
  id: string;
  tenant_id: string;
  webhook_id: string;
  display_name: string;
  slack_app_id: string;
  slack_app_name: string | null;
  slack_team_id: string;
  slack_team_name: string | null;
  slack_bot_user_id: string;
  slack_bot_id: string | null;
  is_enterprise_install: boolean;
  dev_runtime_enabled: boolean;
  dev_runtime_command: string;
  bot_token_ciphertext: string;
  signing_secret_ciphertext: string;
  credential_key_id: string;
  credential_fingerprint: string;
  status: SlackInstallationStatus;
  webhook_verified_at: Date | null;
  last_token_verified_at: Date;
  last_error_code: string | null;
  revision: string | number;
  created_at: Date;
  updated_at: Date;
  agent_id: string;
}

export class PrismaSlackInstallationRepository implements SlackInstallationRepository {
  private initialized?: Promise<void>;
  private readonly keyring: SlackCredentialKeyring;

  constructor(private readonly prisma: PrismaClient, keyring: string | SlackCredentialKeyring) {
    this.keyring = normalizeSlackKeyring(keyring);
  }

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaSlackInstallationRepository has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> { await this.ready(); await this.prisma.$queryRaw`SELECT 1`; }

  async list(tenantId: string): Promise<readonly SlackInstallation[]> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<InstallationRow[]>(`${SELECT_INSTALLATION} WHERE i.tenant_id=$1 AND i.deleted_at IS NULL ORDER BY i.created_at DESC`, tenantId);
    return rows.map(row => rowToInstallation(row));
  }

  async get(tenantId: string, id: string): Promise<SlackInstallation | undefined> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<InstallationRow[]>(`${SELECT_INSTALLATION} WHERE i.tenant_id=$1 AND i.id=$2::uuid AND i.deleted_at IS NULL`, tenantId, id);
    return rows[0] ? rowToInstallation(rows[0]) : undefined;
  }

  async getRuntimeByWebhookId(webhookId: string): Promise<SlackRuntimeInstallation | undefined> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<InstallationRow[]>(`${SELECT_INSTALLATION} WHERE i.webhook_id=$1::uuid AND i.deleted_at IS NULL`, webhookId);
    const row = rows[0];
    if (!row) return undefined;
    return runtimeRowInstallation(row, this.keyring);
  }

  async create(input: CreateSlackInstallationInput): Promise<SlackInstallation> {
    await this.ready();
    const id = randomUUID();
    const webhookId = randomUUID();
    const now = new Date();
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(
        `INSERT INTO platform_slack_app_installations
         (id,tenant_id,webhook_id,display_name,slack_app_id,slack_app_name,slack_team_id,slack_team_name,
          slack_bot_user_id,slack_bot_id,is_enterprise_install,dev_runtime_enabled,dev_runtime_command,bot_token_ciphertext,signing_secret_ciphertext,
          credential_key_id,credential_fingerprint,status,revision,last_token_verified_at,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'awaiting_webhook',1,$18,$19,$19)`,
        id, input.tenantId, webhookId, input.displayName, input.identity.appId, input.identity.appName ?? null,
          input.identity.teamId, input.identity.teamName ?? null, input.identity.botUserId, input.identity.botId ?? null,
          input.identity.enterpriseInstall ?? false, input.devRuntimeEnabled ?? false,
          input.devRuntimeCommand ?? DEFAULT_SLACK_DEV_RUNTIME_COMMAND,
          encryptSlackCredential(input.botToken, activeSlackKey(this.keyring), {
            tenantId: input.tenantId, installationId: id, field: "bot-token",
          }, this.keyring.activeKeyId),
          encryptSlackCredential(input.signingSecret, activeSlackKey(this.keyring), {
            tenantId: input.tenantId, installationId: id, field: "signing-secret",
          }, this.keyring.activeKeyId),
          this.keyring.activeKeyId, fingerprint(input.botToken, activeSlackKey(this.keyring)), now, input.actorId,
        );
        await insertBinding(tx, input.tenantId, id, input.agentId, input.actorId);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new SlackInstallationRepositoryError("duplicate", "This Slack App installation is already managed");
      throw error;
    }
    return (await this.get(input.tenantId, id))!;
  }

  async updateCredentials(input: UpdateSlackCredentialsInput): Promise<SlackInstallation> {
    await this.ready();
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE platform_slack_app_installations SET
       slack_app_id=$4,slack_app_name=$5,slack_team_id=$6,slack_team_name=$7,slack_bot_user_id=$8,slack_bot_id=$9,
       is_enterprise_install=$10,dev_runtime_enabled=COALESCE($11,dev_runtime_enabled),dev_runtime_command=COALESCE($12,dev_runtime_command),bot_token_ciphertext=$13,signing_secret_ciphertext=$14,credential_key_id=$15,credential_fingerprint=$16,
       status='awaiting_webhook',webhook_verified_at=NULL,last_token_verified_at=now(),last_error_code=NULL,
       revision=revision+1,updated_by=$17,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
      input.tenantId, input.id, input.expectedRevision, input.identity.appId, input.identity.appName ?? null,
        input.identity.teamId, input.identity.teamName ?? null, input.identity.botUserId, input.identity.botId ?? null,
        input.identity.enterpriseInstall ?? false, input.devRuntimeEnabled ?? null,
        input.devRuntimeCommand ?? null,
        encryptSlackCredential(input.botToken, activeSlackKey(this.keyring), {
          tenantId: input.tenantId, installationId: input.id, field: "bot-token",
        }, this.keyring.activeKeyId),
        encryptSlackCredential(input.signingSecret, activeSlackKey(this.keyring), {
          tenantId: input.tenantId, installationId: input.id, field: "signing-secret",
        }, this.keyring.activeKeyId),
        this.keyring.activeKeyId, fingerprint(input.botToken, activeSlackKey(this.keyring)), input.actorId,
    ).catch(error => {
      if (isUniqueViolation(error)) throw new SlackInstallationRepositoryError("duplicate", "This Slack App installation is already managed");
      throw error;
    });
    if (count !== 1) await this.throwMissingOrConflict(input.tenantId, input.id);
    return (await this.get(input.tenantId, input.id))!;
  }

  async rotateCredentials(
    tenantId: string,
    id: string,
    expectedRevision: number,
    actorId: string,
  ): Promise<SlackInstallation> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<InstallationRow[]>(
      `${SELECT_INSTALLATION} WHERE i.tenant_id=$1 AND i.id=$2::uuid AND i.deleted_at IS NULL`,
      tenantId,
      id,
    );
    const current = rows[0];
    if (!current) throw new SlackInstallationRepositoryError("not_found", "Slack App connection was not found");
    if (Number(current.revision) !== expectedRevision) {
      throw new SlackInstallationRepositoryError("revision_conflict", "Slack App connection changed; reload and try again");
    }
    const credentials = decryptRowSlackCredentials(current, this.keyring);
    const activeKey = activeSlackKey(this.keyring);
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE platform_slack_app_installations SET
       bot_token_ciphertext=$4,signing_secret_ciphertext=$5,credential_key_id=$6,credential_fingerprint=$7,
       revision=revision+1,updated_by=$8,updated_at=now()
       WHERE tenant_id=$1 AND id=$2::uuid AND revision=$3 AND deleted_at IS NULL`,
      tenantId,
      id,
      expectedRevision,
      encryptSlackCredential(credentials.botToken, activeKey, {
        tenantId, installationId: id, field: "bot-token",
      }, this.keyring.activeKeyId),
      encryptSlackCredential(credentials.signingSecret, activeKey, {
        tenantId, installationId: id, field: "signing-secret",
      }, this.keyring.activeKeyId),
      this.keyring.activeKeyId,
      fingerprint(credentials.botToken, activeKey),
      actorId,
    );
    if (count !== 1) await this.throwMissingOrConflict(tenantId, id);
    return (await this.get(tenantId, id))!;
  }

  async rebind(tenantId: string, id: string, agentId: string, expectedRevision: number, actorId: string): Promise<SlackInstallation> {
    await this.ready();
    await this.prisma.$transaction(async tx => {
      const updated = await tx.$executeRawUnsafe(
        "UPDATE platform_slack_app_installations SET revision=revision+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL",
        tenantId, id, expectedRevision, actorId,
      );
      if (updated !== 1) await throwMissingOrConflict(tx, tenantId, id);
      await tx.$executeRawUnsafe("UPDATE platform_trigger_bindings SET status='inactive',unbound_at=now() WHERE tenant_id=$1 AND provider_id='slack' AND connection_id=$2 AND status='active'", tenantId, id);
      await insertBinding(tx, tenantId, id, agentId, actorId);
    });
    return (await this.get(tenantId, id))!;
  }

  async setDevRuntimeConfiguration(
    tenantId: string,
    id: string,
    configuration: { enabled?: boolean; command?: string },
    expectedRevision: number,
    actorId: string,
  ): Promise<SlackInstallation> {
    await this.ready();
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE platform_slack_app_installations SET
       dev_runtime_enabled=COALESCE($4,dev_runtime_enabled),dev_runtime_command=COALESCE($5,dev_runtime_command),
       revision=revision+1,updated_by=$6,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
      tenantId, id, expectedRevision, configuration.enabled ?? null, configuration.command ?? null, actorId,
    );
    if (count !== 1) await this.throwMissingOrConflict(tenantId, id);
    return (await this.get(tenantId, id))!;
  }

  async setEnabled(tenantId: string, id: string, enabled: boolean, expectedRevision: number, actorId: string): Promise<SlackInstallation> {
    await this.ready();
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE platform_slack_app_installations SET status=CASE WHEN $4 THEN CASE WHEN webhook_verified_at IS NULL THEN 'awaiting_webhook' ELSE 'active' END ELSE 'disabled' END,
       last_error_code=NULL,revision=revision+1,updated_by=$5,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
      tenantId, id, expectedRevision, enabled, actorId,
    );
    if (count !== 1) await this.throwMissingOrConflict(tenantId, id);
    return (await this.get(tenantId, id))!;
  }

  async markWebhookVerified(webhookId: string): Promise<SlackInstallation | undefined> {
    await this.ready();
    const rows = await this.prisma.$queryRawUnsafe<Array<Pick<InstallationRow, "id" | "tenant_id">>>(
      `UPDATE platform_slack_app_installations SET webhook_verified_at=now(),status=CASE WHEN status='disabled' THEN status ELSE 'active' END,
       last_error_code=NULL,revision=revision+1,updated_at=now() WHERE webhook_id=$1 AND deleted_at IS NULL RETURNING id, tenant_id`,
      webhookId,
    );
    const row = rows[0];
    return row ? await this.get(row.tenant_id, row.id) : undefined;
  }

  async markError(webhookId: string, code: string): Promise<void> {
    await this.ready();
    await this.prisma.$executeRawUnsafe(
      "UPDATE platform_slack_app_installations SET status='error',last_error_code=$2,revision=revision+1,updated_at=now() WHERE webhook_id=$1 AND status<>'disabled' AND deleted_at IS NULL",
      webhookId, code,
    );
  }

  async delete(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<void> {
    await this.ready();
    await this.prisma.$transaction(async tx => {
      const count = await tx.$executeRawUnsafe(
        `UPDATE platform_slack_app_installations SET status='disabled',bot_token_ciphertext='',signing_secret_ciphertext='',
         revision=revision+1,deleted_at=now(),updated_at=now(),updated_by=$4 WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
        tenantId, id, expectedRevision, actorId,
      );
      if (count !== 1) await throwMissingOrConflict(tx, tenantId, id);
      await tx.$executeRawUnsafe("UPDATE platform_trigger_bindings SET status='inactive',unbound_at=now() WHERE tenant_id=$1 AND provider_id='slack' AND connection_id=$2 AND status='active'", tenantId, id);
    });
  }

  async close(): Promise<void> {}

  private async throwMissingOrConflict(tenantId: string, id: string): Promise<never> {
    return throwMissingOrConflict(this.prisma, tenantId, id);
  }
}

function sameSlackInstallation(left: SlackInstallationIdentity, right: SlackInstallationIdentity): boolean {
  return left.appId === right.appId && left.teamId === right.teamId;
}

function fingerprint(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function bump(record: StoredInstallation): void {
  record.revision += 1;
  record.updatedAt = new Date().toISOString();
}

function publicInstallation(record: StoredInstallation): SlackInstallation {
  const { botTokenCiphertext: _botToken, signingSecretCiphertext: _signingSecret, credentialFingerprint: _fingerprint, ...safe } = record;
  return structuredClone(safe);
}

function runtimeInstallation(record: StoredInstallation, keyring: SlackCredentialKeyring): SlackRuntimeInstallation {
  const credentials = decryptStoredSlackCredentials(record, keyring);
  return {
    ...publicInstallation(record),
    ...credentials,
  };
}

function runtimeRowInstallation(row: InstallationRow, keyring: SlackCredentialKeyring): SlackRuntimeInstallation {
  return { ...rowToInstallation(row), ...decryptRowSlackCredentials(row, keyring) };
}

function decryptStoredSlackCredentials(
  record: StoredInstallation,
  keyring: SlackCredentialKeyring,
): { botToken: string; signingSecret: string } {
  return decryptSlackCredentials(
    record.botTokenCiphertext,
    record.signingSecretCiphertext,
    record.credentialKeyId,
    record.tenantId,
    record.id,
    keyring,
  );
}

function decryptRowSlackCredentials(
  row: InstallationRow,
  keyring: SlackCredentialKeyring,
): { botToken: string; signingSecret: string } {
  return decryptSlackCredentials(
    row.bot_token_ciphertext,
    row.signing_secret_ciphertext,
    row.credential_key_id,
    row.tenant_id,
    row.id,
    keyring,
  );
}

function decryptSlackCredentials(
  botTokenCiphertext: string,
  signingSecretCiphertext: string,
  credentialKeyId: string,
  tenantId: string,
  installationId: string,
  keyring: SlackCredentialKeyring,
): { botToken: string; signingSecret: string } {
  const key = Object.hasOwn(keyring.keys, credentialKeyId) ? keyring.keys[credentialKeyId] : undefined;
  if (!key) {
    throw new SlackInstallationRepositoryError(
      "key_unavailable",
      "Slack App credential key is unavailable",
    );
  }
  try {
    return {
      botToken: decryptSlackCredential(botTokenCiphertext, key, {
        tenantId, installationId, field: "bot-token",
      }, credentialKeyId),
      signingSecret: decryptSlackCredential(signingSecretCiphertext, key, {
        tenantId, installationId, field: "signing-secret",
      }, credentialKeyId),
    };
  } catch {
    throw new SlackInstallationRepositoryError(
      "invalid_credentials",
      "Slack App credentials could not be decrypted",
    );
  }
}

function normalizeSlackKeyring(keyring: string | SlackCredentialKeyring): SlackCredentialKeyring {
  if (typeof keyring === "string") {
    if (!keyring.trim()) throw new Error("Slack credential encryption key must not be empty");
    return { activeKeyId: "default", keys: Object.freeze({ default: keyring }) };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(keyring.activeKeyId)
    || !Object.hasOwn(keyring.keys, keyring.activeKeyId)) {
    throw new Error("Slack credential keyring active key is unavailable");
  }
  const entries = Object.entries(keyring.keys);
  if (entries.length === 0 || entries.length > 16) throw new Error("Slack credential keyring size is invalid");
  for (const [keyId, key] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(keyId)
      || Buffer.byteLength(key, "utf8") < 32) {
      throw new Error("Slack credential keyring contains an invalid key");
    }
  }
  if (new Set(entries.map(([, key]) => key)).size !== entries.length) {
    throw new Error("Slack credential keyring contains duplicate key material");
  }
  return keyring;
}

function activeSlackKey(keyring: SlackCredentialKeyring): string {
  const key = Object.hasOwn(keyring.keys, keyring.activeKeyId)
    ? keyring.keys[keyring.activeKeyId]
    : undefined;
  if (!key) throw new Error("Slack credential keyring active key is unavailable");
  return key;
}

function rowToInstallation(row: InstallationRow): SlackInstallation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    webhookId: row.webhook_id,
    displayName: row.display_name,
    identity: {
      appId: row.slack_app_id,
      ...(row.slack_app_name ? { appName: row.slack_app_name } : {}),
      teamId: row.slack_team_id,
      ...(row.slack_team_name ? { teamName: row.slack_team_name } : {}),
      botUserId: row.slack_bot_user_id,
      ...(row.slack_bot_id ? { botId: row.slack_bot_id } : {}),
      ...(row.is_enterprise_install ? { enterpriseInstall: true } : {}),
    },
    agentId: row.agent_id,
    devRuntimeEnabled: row.dev_runtime_enabled,
    devRuntimeCommand: row.dev_runtime_command,
    status: row.status,
    revision: Number(row.revision),
    credentialKeyId: row.credential_key_id,
    ...(row.webhook_verified_at ? { webhookVerifiedAt: row.webhook_verified_at.toISOString() } : {}),
    lastTokenVerifiedAt: row.last_token_verified_at.toISOString(),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function insertBinding(client: Prisma.TransactionClient, tenantId: string, installationId: string, agentId: string, actorId: string): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO platform_trigger_bindings(id,tenant_id,provider_id,connection_id,application_id,target_kind,target_id,status,revision,bound_by)
     VALUES($1,$2,'slack',$3,'qasey','agent',$4,'active',1,$5)`,
    randomUUID(), tenantId, installationId, agentId, actorId,
  );
}

async function throwMissingOrConflict(
  client: Pick<Prisma.TransactionClient, "platformSlackAppInstallation">,
  tenantId: string,
  id: string,
): Promise<never> {
  const current = await client.platformSlackAppInstallation.findFirst({
    where: { tenantId, id, deletedAt: null },
    select: { revision: true },
  });
  throw new SlackInstallationRepositoryError(current ? "revision_conflict" : "not_found", current
    ? "Slack App connection changed; reload and try again"
    : "Slack App connection was not found");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "23505" || error.code === "P2002");
}

const SELECT_INSTALLATION = `SELECT i.*, b.target_id AS agent_id FROM platform_slack_app_installations i
  JOIN platform_trigger_bindings b ON b.connection_id=i.id::text AND b.provider_id='slack' AND b.tenant_id=i.tenant_id AND b.status='active'`;
