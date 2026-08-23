-- Run while connected to the fresh moego_qasey database.
-- 本文件下面的所有表和索引都属于 moego_qasey。
-- 本文件不会写入 moego_qasey_observability；后者仅由 Mastra Observability 使用。
DO $$
BEGIN
  IF current_database() <> 'moego_qasey' THEN
    RAISE EXCEPTION 'Connect to moego_qasey before running this script; current database is %', current_database();
  END IF;
END
$$;

-- moego_qasey：各 Agent Application 的 run 与 event。
CREATE TABLE IF NOT EXISTS agent_application_runs (
  application_id text NOT NULL, tenant_id text NOT NULL, id text NOT NULL,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, tenant_id, id)
);
CREATE TABLE IF NOT EXISTS agent_application_run_events (
  application_id text NOT NULL, tenant_id text NOT NULL, id text NOT NULL,
  run_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, tenant_id, id),
  FOREIGN KEY (application_id, tenant_id, run_id)
    REFERENCES agent_application_runs(application_id, tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_application_run_events_owner_idx
  ON agent_application_run_events(application_id, tenant_id, run_id, created_at);

-- moego_qasey：平台 RBAC、授权关系与审计日志。
CREATE TABLE IF NOT EXISTS platform_roles (
  tenant_id text NOT NULL, role_id text NOT NULL, PRIMARY KEY (tenant_id, role_id)
);
CREATE TABLE IF NOT EXISTS platform_role_permissions (
  tenant_id text NOT NULL, role_id text NOT NULL, permission text NOT NULL,
  PRIMARY KEY (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES platform_roles(tenant_id, role_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS platform_subject_roles (
  tenant_id text NOT NULL, subject_id text NOT NULL, role_id text NOT NULL,
  PRIMARY KEY (tenant_id, subject_id, role_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES platform_roles(tenant_id, role_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL, tenant_id text, subject_id text, application_id text,
  resource_type text NOT NULL, resource_id text NOT NULL, action text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')), reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

-- moego_qasey：渠道投递幂等记录。
CREATE TABLE IF NOT EXISTS platform_channel_deliveries (
  application_id text NOT NULL, tenant_id text NOT NULL, delivery_id text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, tenant_id, delivery_id)
);

-- moego_qasey：由 Admin UI 管理的 Slack App installation 与 Agent 绑定。
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
  ON platform_trigger_bindings(provider_id, connection_id) WHERE status = 'active';

-- moego_qasey：Qasey MCP 集成的加密 OAuth credential。
CREATE TABLE IF NOT EXISTS qasey_mcp_oauth_credentials (
  namespace text NOT NULL, storage_key text NOT NULL, encrypted_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace, storage_key)
);
