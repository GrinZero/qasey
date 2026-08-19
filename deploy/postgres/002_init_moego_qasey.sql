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

-- moego_qasey：Qasey MCP 集成的加密 OAuth credential。
CREATE TABLE IF NOT EXISTS qasey_mcp_oauth_credentials (
  namespace text NOT NULL, storage_key text NOT NULL, encrypted_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace, storage_key)
);
