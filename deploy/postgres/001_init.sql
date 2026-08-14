CREATE TABLE IF NOT EXISTS qasey_trigger_jobs (
  id uuid PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, envelope jsonb NOT NULL, request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text, locked_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qasey_trigger_jobs_claim_idx ON qasey_trigger_jobs(status, available_at, created_at);
CREATE TABLE IF NOT EXISTS qasey_notification_outbox (
  id text PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), locked_by text, locked_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qasey_notification_claim_idx ON qasey_notification_outbox(status, available_at, created_at);
ALTER TABLE qasey_notification_outbox ADD COLUMN IF NOT EXISTS locked_at timestamptz;
CREATE TABLE IF NOT EXISTS qasey_mcp_oauth_credentials (
  namespace text NOT NULL,
  storage_key text NOT NULL,
  encrypted_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace, storage_key)
);
