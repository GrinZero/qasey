import { createHmac, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
    readonly code: "not_found" | "duplicate" | "revision_conflict",
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

export class InMemorySlackInstallationRepository implements SlackInstallationRepository {
  private readonly records = new Map<string, StoredInstallation>();

  constructor(private readonly encryptionKey: string) {}

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
    return record ? runtimeInstallation(record, this.encryptionKey) : undefined;
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
      lastTokenVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
      botTokenCiphertext: encryptSlackCredential(input.botToken, this.encryptionKey, {
        tenantId: input.tenantId, installationId: id, field: "bot-token",
      }),
      signingSecretCiphertext: encryptSlackCredential(input.signingSecret, this.encryptionKey, {
        tenantId: input.tenantId, installationId: id, field: "signing-secret",
      }),
      credentialFingerprint: fingerprint(input.botToken, this.encryptionKey),
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
    record.botTokenCiphertext = encryptSlackCredential(input.botToken, this.encryptionKey, {
      tenantId: input.tenantId, installationId: input.id, field: "bot-token",
    });
    record.signingSecretCiphertext = encryptSlackCredential(input.signingSecret, this.encryptionKey, {
      tenantId: input.tenantId, installationId: input.id, field: "signing-secret",
    });
    record.credentialFingerprint = fingerprint(input.botToken, this.encryptionKey);
    if (input.devRuntimeEnabled !== undefined) record.devRuntimeEnabled = input.devRuntimeEnabled;
    if (input.devRuntimeCommand !== undefined) record.devRuntimeCommand = input.devRuntimeCommand;
    record.status = "awaiting_webhook";
    delete record.webhookVerifiedAt;
    record.lastTokenVerifiedAt = new Date().toISOString();
    delete record.lastErrorCode;
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

export class PostgresSlackInstallationRepository implements SlackInstallationRepository {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string, private readonly encryptionKey: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  init(): Promise<void> {
    this.initialized ??= this.pool.query(SLACK_INSTALLATION_SCHEMA).then(() => undefined);
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PostgresSlackInstallationRepository has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> { await this.ready(); await this.pool.query("SELECT 1"); }

  async list(tenantId: string): Promise<readonly SlackInstallation[]> {
    await this.ready();
    const result = await this.pool.query<InstallationRow>(`${SELECT_INSTALLATION} WHERE i.tenant_id=$1 AND i.deleted_at IS NULL ORDER BY i.created_at DESC`, [tenantId]);
    return result.rows.map(row => rowToInstallation(row));
  }

  async get(tenantId: string, id: string): Promise<SlackInstallation | undefined> {
    await this.ready();
    const result = await this.pool.query<InstallationRow>(`${SELECT_INSTALLATION} WHERE i.tenant_id=$1 AND i.id=$2 AND i.deleted_at IS NULL`, [tenantId, id]);
    return result.rows[0] ? rowToInstallation(result.rows[0]) : undefined;
  }

  async getRuntimeByWebhookId(webhookId: string): Promise<SlackRuntimeInstallation | undefined> {
    await this.ready();
    const result = await this.pool.query<InstallationRow>(`${SELECT_INSTALLATION} WHERE i.webhook_id=$1 AND i.deleted_at IS NULL`, [webhookId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      ...rowToInstallation(row),
      botToken: decryptSlackCredential(row.bot_token_ciphertext, this.encryptionKey, {
        tenantId: row.tenant_id, installationId: row.id, field: "bot-token",
      }),
      signingSecret: decryptSlackCredential(row.signing_secret_ciphertext, this.encryptionKey, {
        tenantId: row.tenant_id, installationId: row.id, field: "signing-secret",
      }),
    };
  }

  async create(input: CreateSlackInstallationInput): Promise<SlackInstallation> {
    await this.ready();
    const id = randomUUID();
    const webhookId = randomUUID();
    const now = new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO platform_slack_app_installations
         (id,tenant_id,webhook_id,display_name,slack_app_id,slack_app_name,slack_team_id,slack_team_name,
          slack_bot_user_id,slack_bot_id,is_enterprise_install,dev_runtime_enabled,dev_runtime_command,bot_token_ciphertext,signing_secret_ciphertext,
          credential_key_id,credential_fingerprint,status,revision,last_token_verified_at,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'default',$16,'awaiting_webhook',1,$17,$18,$18)`,
        [id, input.tenantId, webhookId, input.displayName, input.identity.appId, input.identity.appName ?? null,
          input.identity.teamId, input.identity.teamName ?? null, input.identity.botUserId, input.identity.botId ?? null,
          input.identity.enterpriseInstall ?? false, input.devRuntimeEnabled ?? false,
          input.devRuntimeCommand ?? DEFAULT_SLACK_DEV_RUNTIME_COMMAND,
          encryptSlackCredential(input.botToken, this.encryptionKey, { tenantId: input.tenantId, installationId: id, field: "bot-token" }),
          encryptSlackCredential(input.signingSecret, this.encryptionKey, { tenantId: input.tenantId, installationId: id, field: "signing-secret" }),
          fingerprint(input.botToken, this.encryptionKey), now, input.actorId],
      );
      await insertBinding(client, input.tenantId, id, input.agentId, input.actorId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new SlackInstallationRepositoryError("duplicate", "This Slack App installation is already managed");
      throw error;
    } finally { client.release(); }
    return (await this.get(input.tenantId, id))!;
  }

  async updateCredentials(input: UpdateSlackCredentialsInput): Promise<SlackInstallation> {
    await this.ready();
    const result = await this.pool.query(
      `UPDATE platform_slack_app_installations SET
       slack_app_id=$4,slack_app_name=$5,slack_team_id=$6,slack_team_name=$7,slack_bot_user_id=$8,slack_bot_id=$9,
       is_enterprise_install=$10,dev_runtime_enabled=COALESCE($11,dev_runtime_enabled),dev_runtime_command=COALESCE($12,dev_runtime_command),bot_token_ciphertext=$13,signing_secret_ciphertext=$14,credential_fingerprint=$15,
       status='awaiting_webhook',webhook_verified_at=NULL,last_token_verified_at=now(),last_error_code=NULL,
       revision=revision+1,updated_by=$16,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
      [input.tenantId, input.id, input.expectedRevision, input.identity.appId, input.identity.appName ?? null,
        input.identity.teamId, input.identity.teamName ?? null, input.identity.botUserId, input.identity.botId ?? null,
        input.identity.enterpriseInstall ?? false, input.devRuntimeEnabled ?? null,
        input.devRuntimeCommand ?? null,
        encryptSlackCredential(input.botToken, this.encryptionKey, { tenantId: input.tenantId, installationId: input.id, field: "bot-token" }),
        encryptSlackCredential(input.signingSecret, this.encryptionKey, { tenantId: input.tenantId, installationId: input.id, field: "signing-secret" }),
        fingerprint(input.botToken, this.encryptionKey), input.actorId],
    ).catch(error => {
      if (isUniqueViolation(error)) throw new SlackInstallationRepositoryError("duplicate", "This Slack App installation is already managed");
      throw error;
    });
    if (result.rowCount !== 1) await this.throwMissingOrConflict(input.tenantId, input.id);
    return (await this.get(input.tenantId, input.id))!;
  }

  async rebind(tenantId: string, id: string, agentId: string, expectedRevision: number, actorId: string): Promise<SlackInstallation> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE platform_slack_app_installations SET revision=revision+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL",
        [tenantId, id, expectedRevision, actorId],
      );
      if (updated.rowCount !== 1) {
        await client.query("ROLLBACK");
        await this.throwMissingOrConflict(tenantId, id);
      }
      await client.query("UPDATE platform_trigger_bindings SET status='inactive',unbound_at=now() WHERE tenant_id=$1 AND provider_id='slack' AND connection_id=$2 AND status='active'", [tenantId, id]);
      await insertBinding(client, tenantId, id, agentId, actorId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
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
    const result = await this.pool.query(
      `UPDATE platform_slack_app_installations SET
       dev_runtime_enabled=COALESCE($4,dev_runtime_enabled),dev_runtime_command=COALESCE($5,dev_runtime_command),
       revision=revision+1,updated_by=$6,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
      [tenantId, id, expectedRevision, configuration.enabled ?? null, configuration.command ?? null, actorId],
    );
    if (result.rowCount !== 1) await this.throwMissingOrConflict(tenantId, id);
    return (await this.get(tenantId, id))!;
  }

  async setEnabled(tenantId: string, id: string, enabled: boolean, expectedRevision: number, actorId: string): Promise<SlackInstallation> {
    await this.ready();
    const result = await this.pool.query(
      `UPDATE platform_slack_app_installations SET status=CASE WHEN $4 THEN CASE WHEN webhook_verified_at IS NULL THEN 'awaiting_webhook' ELSE 'active' END ELSE 'disabled' END,
       last_error_code=NULL,revision=revision+1,updated_by=$5,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
      [tenantId, id, expectedRevision, enabled, actorId],
    );
    if (result.rowCount !== 1) await this.throwMissingOrConflict(tenantId, id);
    return (await this.get(tenantId, id))!;
  }

  async markWebhookVerified(webhookId: string): Promise<SlackInstallation | undefined> {
    await this.ready();
    const result = await this.pool.query<InstallationRow>(
      `UPDATE platform_slack_app_installations SET webhook_verified_at=now(),status=CASE WHEN status='disabled' THEN status ELSE 'active' END,
       last_error_code=NULL,revision=revision+1,updated_at=now() WHERE webhook_id=$1 AND deleted_at IS NULL RETURNING id, tenant_id`,
      [webhookId],
    );
    const row = result.rows[0];
    return row ? await this.get(row.tenant_id, row.id) : undefined;
  }

  async markError(webhookId: string, code: string): Promise<void> {
    await this.ready();
    await this.pool.query(
      "UPDATE platform_slack_app_installations SET status='error',last_error_code=$2,revision=revision+1,updated_at=now() WHERE webhook_id=$1 AND status<>'disabled' AND deleted_at IS NULL",
      [webhookId, code],
    );
  }

  async delete(tenantId: string, id: string, expectedRevision: number, actorId: string): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE platform_slack_app_installations SET status='disabled',bot_token_ciphertext='',signing_secret_ciphertext='',
         revision=revision+1,deleted_at=now(),updated_at=now(),updated_by=$4 WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND deleted_at IS NULL`,
        [tenantId, id, expectedRevision, actorId],
      );
      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        await this.throwMissingOrConflict(tenantId, id);
      }
      await client.query("UPDATE platform_trigger_bindings SET status='inactive',unbound_at=now() WHERE tenant_id=$1 AND provider_id='slack' AND connection_id=$2 AND status='active'", [tenantId, id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async throwMissingOrConflict(tenantId: string, id: string): Promise<never> {
    const current = await this.pool.query("SELECT revision FROM platform_slack_app_installations WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL", [tenantId, id]);
    throw new SlackInstallationRepositoryError(current.rowCount ? "revision_conflict" : "not_found", current.rowCount
      ? "Slack App connection changed; reload and try again"
      : "Slack App connection was not found");
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

function runtimeInstallation(record: StoredInstallation, encryptionKey: string): SlackRuntimeInstallation {
  return {
    ...publicInstallation(record),
    botToken: decryptSlackCredential(record.botTokenCiphertext, encryptionKey, {
      tenantId: record.tenantId, installationId: record.id, field: "bot-token",
    }),
    signingSecret: decryptSlackCredential(record.signingSecretCiphertext, encryptionKey, {
      tenantId: record.tenantId, installationId: record.id, field: "signing-secret",
    }),
  };
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
    ...(row.webhook_verified_at ? { webhookVerifiedAt: row.webhook_verified_at.toISOString() } : {}),
    lastTokenVerifiedAt: row.last_token_verified_at.toISOString(),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function insertBinding(client: PoolClient, tenantId: string, installationId: string, agentId: string, actorId: string): Promise<void> {
  await client.query(
    `INSERT INTO platform_trigger_bindings(id,tenant_id,provider_id,connection_id,application_id,target_kind,target_id,status,revision,bound_by)
     VALUES($1,$2,'slack',$3,'qasey','agent',$4,'active',1,$5)`,
    [randomUUID(), tenantId, installationId, agentId, actorId],
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

const SELECT_INSTALLATION = `SELECT i.*, b.target_id AS agent_id FROM platform_slack_app_installations i
  JOIN platform_trigger_bindings b ON b.connection_id=i.id::text AND b.provider_id='slack' AND b.tenant_id=i.tenant_id AND b.status='active'`;

export const SLACK_INSTALLATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS platform_slack_app_installations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  webhook_id uuid UNIQUE NOT NULL,
  display_name text NOT NULL,
  slack_app_id text NOT NULL,
  slack_app_name text,
  slack_team_id text NOT NULL,
  slack_team_name text,
  slack_bot_user_id text NOT NULL,
  slack_bot_id text,
  is_enterprise_install boolean NOT NULL DEFAULT false,
  dev_runtime_enabled boolean NOT NULL DEFAULT false,
  dev_runtime_command text NOT NULL DEFAULT '/qasey-local',
  bot_token_ciphertext text NOT NULL,
  signing_secret_ciphertext text NOT NULL,
  credential_key_id text NOT NULL,
  credential_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_webhook','active','disabled','error')),
  webhook_verified_at timestamptz,
  last_token_verified_at timestamptz NOT NULL,
  last_error_code text,
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
ALTER TABLE platform_slack_app_installations
  ADD COLUMN IF NOT EXISTS dev_runtime_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE platform_slack_app_installations
  ADD COLUMN IF NOT EXISTS dev_runtime_command text NOT NULL DEFAULT '/qasey-local';
CREATE UNIQUE INDEX IF NOT EXISTS platform_slack_installation_identity_idx
  ON platform_slack_app_installations(slack_app_id, slack_team_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS platform_trigger_bindings (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  provider_id text NOT NULL,
  connection_id text NOT NULL,
  application_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('agent','workflow')),
  target_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','inactive')),
  revision bigint NOT NULL DEFAULT 1,
  bound_by text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  unbound_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_trigger_binding_active_idx
  ON platform_trigger_bindings(provider_id, connection_id) WHERE status='active';
`;
