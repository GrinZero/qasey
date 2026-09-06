-- The pre-review Case Hub data model coupled text cases to E2E delivery. This
-- one-time cutover intentionally clears only that Case Hub projection. Runs,
-- conversations, events and artifacts remain available as historical logs.
DELETE FROM qasey_case_results;
DELETE FROM qasey_case_versions;
DELETE FROM qasey_cases;
DELETE FROM qasey_case_change_sets;

UPDATE qasey_case_projects
SET next_case_sequence = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE code = 'QASEY';

ALTER TABLE qasey_case_versions
ALTER COLUMN change_set_id DROP NOT NULL;

CREATE TABLE qasey_case_review_plans (
  application_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  id UUID NOT NULL,
  conversation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT qasey_case_review_plans_pkey PRIMARY KEY (application_id, tenant_id, id)
);

CREATE INDEX qasey_case_review_plans_conversation_idx
ON qasey_case_review_plans(application_id, tenant_id, conversation_id, updated_at DESC);

CREATE INDEX qasey_case_review_plans_status_idx
ON qasey_case_review_plans(application_id, tenant_id, status, updated_at DESC);

CREATE TABLE qasey_case_review_items (
  application_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  id UUID NOT NULL,
  plan_id UUID NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT qasey_case_review_items_pkey PRIMARY KEY (application_id, tenant_id, id)
);

CREATE UNIQUE INDEX qasey_case_review_items_ordinal_key
ON qasey_case_review_items(application_id, tenant_id, plan_id, ordinal);

CREATE INDEX qasey_case_review_items_plan_idx
ON qasey_case_review_items(application_id, tenant_id, plan_id, status);
