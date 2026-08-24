CREATE TABLE IF NOT EXISTS "agent_application_runs" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_application_runs_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);

CREATE TABLE IF NOT EXISTS "agent_application_run_events" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_application_run_events_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);

CREATE INDEX IF NOT EXISTS "agent_application_run_events_owner_idx"
  ON "agent_application_run_events"("application_id", "tenant_id", "run_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "agent_application_run_events"
    ADD CONSTRAINT "agent_application_run_events_application_id_tenant_id_run_id_fkey"
    FOREIGN KEY ("application_id", "tenant_id", "run_id")
    REFERENCES "agent_application_runs"("application_id", "tenant_id", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "platform_channel_deliveries" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_channel_deliveries_pkey" PRIMARY KEY ("application_id", "tenant_id", "delivery_id")
);

CREATE TABLE IF NOT EXISTS "platform_roles" (
  "tenant_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("tenant_id", "role_id")
);

CREATE TABLE IF NOT EXISTS "platform_role_permissions" (
  "tenant_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  CONSTRAINT "platform_role_permissions_pkey" PRIMARY KEY ("tenant_id", "role_id", "permission")
);

CREATE TABLE IF NOT EXISTS "platform_subject_roles" (
  "tenant_id" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  CONSTRAINT "platform_subject_roles_pkey" PRIMARY KEY ("tenant_id", "subject_id", "role_id")
);

DO $$ BEGIN
  ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_tenant_id_role_id_fkey"
    FOREIGN KEY ("tenant_id", "role_id") REFERENCES "platform_roles"("tenant_id", "role_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "platform_subject_roles" ADD CONSTRAINT "platform_subject_roles_tenant_id_role_id_fkey"
    FOREIGN KEY ("tenant_id", "role_id") REFERENCES "platform_roles"("tenant_id", "role_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "platform_audit_log" (
  "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "request_id" TEXT NOT NULL,
  "tenant_id" TEXT,
  "subject_id" TEXT,
  "application_id" TEXT,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "decision" TEXT NOT NULL CHECK ("decision" IN ('allow', 'deny')),
  "reason" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "platform_audit_log_tenant_id_idx" ON "platform_audit_log"("tenant_id", "id" DESC);

CREATE TABLE IF NOT EXISTS "platform_api_tokens" (
  "id" UUID PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "token_prefix" TEXT NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ,
  "last_used_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "platform_api_tokens_tenant_created_idx"
  ON "platform_api_tokens"("tenant_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "platform_slack_app_installations" (
  "id" UUID PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "webhook_id" UUID UNIQUE NOT NULL,
  "display_name" TEXT NOT NULL,
  "slack_app_id" TEXT NOT NULL,
  "slack_app_name" TEXT,
  "slack_team_id" TEXT NOT NULL,
  "slack_team_name" TEXT,
  "slack_bot_user_id" TEXT NOT NULL,
  "slack_bot_id" TEXT,
  "is_enterprise_install" BOOLEAN NOT NULL DEFAULT false,
  "dev_runtime_enabled" BOOLEAN NOT NULL DEFAULT false,
  "dev_runtime_command" TEXT NOT NULL DEFAULT '/qasey-local',
  "bot_token_ciphertext" TEXT NOT NULL,
  "signing_secret_ciphertext" TEXT NOT NULL,
  "credential_key_id" TEXT NOT NULL,
  "credential_fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('awaiting_webhook','active','disabled','error')),
  "webhook_verified_at" TIMESTAMPTZ,
  "last_token_verified_at" TIMESTAMPTZ NOT NULL,
  "last_error_code" TEXT,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ
);

ALTER TABLE "platform_slack_app_installations"
  ADD COLUMN IF NOT EXISTS "dev_runtime_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "platform_slack_app_installations"
  ADD COLUMN IF NOT EXISTS "dev_runtime_command" TEXT NOT NULL DEFAULT '/qasey-local';
CREATE UNIQUE INDEX IF NOT EXISTS "platform_slack_installation_identity_idx"
  ON "platform_slack_app_installations"("slack_app_id", "slack_team_id") WHERE "deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "platform_trigger_bindings" (
  "id" UUID PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "application_id" TEXT NOT NULL,
  "target_kind" TEXT NOT NULL CHECK ("target_kind" IN ('agent','workflow')),
  "target_id" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('active','inactive')),
  "revision" BIGINT NOT NULL DEFAULT 1,
  "bound_by" TEXT NOT NULL,
  "bound_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unbound_at" TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS "platform_trigger_binding_active_idx"
  ON "platform_trigger_bindings"("provider_id", "connection_id") WHERE "status"='active';

CREATE TABLE IF NOT EXISTS "qasey_sandbox_leases" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "sandbox_ordinal" INTEGER NOT NULL CHECK ("sandbox_ordinal" >= 0),
  "lease_generation" INTEGER NOT NULL CHECK ("lease_generation" > 0),
  "encrypted_token" TEXT NOT NULL,
  "state" TEXT NOT NULL CHECK ("state" IN ('active', 'idle')),
  "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_sandbox_leases_pkey" PRIMARY KEY ("application_id", "tenant_id", "session_id")
);

CREATE INDEX IF NOT EXISTS "qasey_sandbox_leases_capacity_idx"
  ON "qasey_sandbox_leases"("state", "sandbox_ordinal", "last_activity_at");

CREATE TABLE IF NOT EXISTS "qasey_mcp_oauth_credentials" (
  "namespace" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "encrypted_value" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_mcp_oauth_credentials_pkey" PRIMARY KEY ("namespace", "storage_key")
);
