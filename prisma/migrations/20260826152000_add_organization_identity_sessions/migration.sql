CREATE TABLE "platform_organizations" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_organizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_organizations_slug_normalized_check" CHECK ("slug" = lower("slug"))
);

CREATE UNIQUE INDEX "platform_organizations_slug_key" ON "platform_organizations"("slug");

CREATE TABLE "platform_users" (
  "id" UUID NOT NULL,
  "display_name" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_user_identities" (
  "provider" TEXT NOT NULL,
  "provider_subject" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "email" TEXT,
  "email_verified" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_user_identities_pkey" PRIMARY KEY ("provider", "provider_subject"),
  CONSTRAINT "platform_user_identities_email_normalized_check" CHECK ("email" IS NULL OR "email" = lower("email"))
);

CREATE INDEX "platform_user_identities_user_idx" ON "platform_user_identities"("user_id");
CREATE UNIQUE INDEX "platform_user_identities_user_provider_key"
  ON "platform_user_identities"("user_id", "provider");

CREATE TABLE "platform_organization_memberships" (
  "organization_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_organization_memberships_pkey" PRIMARY KEY ("organization_id", "user_id"),
  CONSTRAINT "platform_organization_memberships_status_check" CHECK ("status" IN ('active', 'suspended', 'removed'))
);

CREATE INDEX "platform_organization_memberships_user_status_idx"
  ON "platform_organization_memberships"("user_id", "status");

CREATE TABLE "platform_organization_domains" (
  "domain" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "verified_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_organization_domains_pkey" PRIMARY KEY ("domain"),
  CONSTRAINT "platform_organization_domains_normalized_check" CHECK ("domain" = lower("domain"))
);

CREATE INDEX "platform_organization_domains_organization_idx"
  ON "platform_organization_domains"("organization_id");

CREATE TABLE "platform_browser_sessions" (
  "id" UUID NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" BYTEA NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "last_seen_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "platform_browser_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_browser_sessions_token_hash_length_check" CHECK (octet_length("token_hash") = 32),
  CONSTRAINT "platform_browser_sessions_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE INDEX "platform_browser_sessions_organization_revoked_idx"
  ON "platform_browser_sessions"("organization_id", "revoked_at");
CREATE INDEX "platform_browser_sessions_user_revoked_idx"
  ON "platform_browser_sessions"("user_id", "revoked_at");

ALTER TABLE "platform_user_identities"
  ADD CONSTRAINT "platform_user_identities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_organization_memberships"
  ADD CONSTRAINT "platform_organization_memberships_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "platform_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_organization_memberships"
  ADD CONSTRAINT "platform_organization_memberships_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_organization_domains"
  ADD CONSTRAINT "platform_organization_domains_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "platform_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_browser_sessions"
  ADD CONSTRAINT "platform_browser_sessions_organization_id_user_id_fkey"
  FOREIGN KEY ("organization_id", "user_id")
  REFERENCES "platform_organization_memberships"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
