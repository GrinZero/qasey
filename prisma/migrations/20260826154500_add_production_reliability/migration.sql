ALTER TABLE "agent_application_runs"
  ADD COLUMN "heartbeat_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "agent_application_runs_heartbeat_status_idx"
  ON "agent_application_runs"("heartbeat_at", ("payload"->>'status'));

CREATE TABLE "platform_external_connections" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "configuration" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "credentials_ciphertext" TEXT NOT NULL,
  "credential_key_id" TEXT NOT NULL,
  "credential_fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 1,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "platform_external_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_external_connections_provider_check" CHECK ("provider" IN ('slack','jira','github','mcp')),
  CONSTRAINT "platform_external_connections_status_check" CHECK ("status" IN ('active','disabled','revoked')),
  CONSTRAINT "platform_external_connections_revision_check" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "platform_external_connections_tenant_provider_name_key"
  ON "platform_external_connections"("tenant_id", "provider", "name");
CREATE INDEX "platform_external_connections_tenant_provider_status_idx"
  ON "platform_external_connections"("tenant_id", "provider", "status");

CREATE TABLE "platform_workflow_failure_inbox" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "id" UUID NOT NULL,
  "run_id" TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "error_code" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_attempt_at" TIMESTAMPTZ,
  "next_attempt_at" TIMESTAMPTZ,
  "redrive_run_id" TEXT,
  "resolved_at" TIMESTAMPTZ,
  "resolved_by" TEXT,
  CONSTRAINT "platform_workflow_failure_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_workflow_failure_inbox_reason_check" CHECK ("reason_code" IN ('heartbeat_timeout','execution_deadline','orphaned_execution','side_effect_unknown')),
  CONSTRAINT "platform_workflow_failure_inbox_status_check" CHECK ("status" IN ('pending','redriving','redriven','exhausted','closed')),
  CONSTRAINT "platform_workflow_failure_inbox_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
  CONSTRAINT "platform_workflow_failure_inbox_run_fkey" FOREIGN KEY ("application_id", "tenant_id", "run_id")
    REFERENCES "agent_application_runs"("application_id", "tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "platform_workflow_failure_inbox_run_reason_key"
  ON "platform_workflow_failure_inbox"("application_id", "tenant_id", "run_id", "reason_code");
CREATE INDEX "platform_workflow_failure_inbox_owner_status_idx"
  ON "platform_workflow_failure_inbox"("application_id", "tenant_id", "status", "next_attempt_at");

CREATE TABLE "platform_workflow_effect_receipts" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "step_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "result" JSONB,
  "external_ref" TEXT,
  "last_error_code" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  CONSTRAINT "platform_workflow_effect_receipts_pkey" PRIMARY KEY ("application_id", "tenant_id", "idempotency_key"),
  CONSTRAINT "platform_workflow_effect_receipts_status_check" CHECK ("status" IN ('pending','succeeded','failed','unknown')),
  CONSTRAINT "platform_workflow_effect_receipts_attempts_check" CHECK ("attempts" > 0),
  CONSTRAINT "platform_workflow_effect_receipts_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "platform_workflow_effect_receipts_run_fkey" FOREIGN KEY ("application_id", "tenant_id", "run_id")
    REFERENCES "agent_application_runs"("application_id", "tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "platform_workflow_effect_receipts_run_step_idx"
  ON "platform_workflow_effect_receipts"("application_id", "tenant_id", "run_id", "step_id");
