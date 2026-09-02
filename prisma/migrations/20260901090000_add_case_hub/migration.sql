CREATE TABLE "qasey_case_projects" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "next_case_sequence" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_case_projects_pkey" PRIMARY KEY ("application_id", "tenant_id", "code")
);

CREATE TABLE "qasey_cases" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "project_code" TEXT NOT NULL,
  "suite_path" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "active_version_id" UUID,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_cases_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);
CREATE INDEX "qasey_cases_repository_idx" ON "qasey_cases"("application_id", "tenant_id", "project_code", "suite_path");

CREATE TABLE "qasey_case_versions" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "id" UUID NOT NULL,
  "case_id" TEXT NOT NULL,
  "change_set_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_case_versions_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);
CREATE UNIQUE INDEX "qasey_case_versions_case_version_key" ON "qasey_case_versions"("application_id", "tenant_id", "case_id", "version");
CREATE INDEX "qasey_case_versions_change_set_idx" ON "qasey_case_versions"("application_id", "tenant_id", "change_set_id");

CREATE TABLE "qasey_case_change_sets" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "id" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_case_change_sets_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);
CREATE INDEX "qasey_case_change_sets_status_idx" ON "qasey_case_change_sets"("application_id", "tenant_id", "status", "updated_at" DESC);

CREATE TABLE "qasey_case_results" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "id" UUID NOT NULL,
  "change_set_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "case_version_id" UUID NOT NULL,
  "case_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "execution_status" TEXT NOT NULL,
  "review_status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_case_results_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);
CREATE UNIQUE INDEX "qasey_case_results_attempt_key" ON "qasey_case_results"("application_id", "tenant_id", "run_id", "case_version_id", "attempt");
CREATE INDEX "qasey_case_results_review_idx" ON "qasey_case_results"("application_id", "tenant_id", "change_set_id", "review_status");

CREATE TABLE "qasey_e2e_fixture_leases" (
  "id" UUID NOT NULL,
  "owner" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qasey_e2e_fixture_leases_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "qasey_e2e_fixture_leases_owner_expiry_idx" ON "qasey_e2e_fixture_leases"("owner", "expires_at");
