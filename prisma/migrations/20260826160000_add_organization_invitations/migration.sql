CREATE TABLE "platform_organization_invitations" (
  "id" UUID NOT NULL,
  "organization_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "invited_by" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ,
  "accepted_by_user_id" UUID,
  "revoked_at" TIMESTAMPTZ,
  "revoked_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_organization_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_organization_invitations_email_normalized_check" CHECK ("email" = lower("email")),
  CONSTRAINT "platform_organization_invitations_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "platform_organization_invitations_acceptance_check" CHECK (
    ("accepted_at" IS NULL AND "accepted_by_user_id" IS NULL)
    OR ("accepted_at" IS NOT NULL AND "accepted_by_user_id" IS NOT NULL)
  ),
  CONSTRAINT "platform_organization_invitations_revocation_check" CHECK (
    ("revoked_at" IS NULL AND "revoked_by" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
  ),
  CONSTRAINT "platform_organization_invitations_terminal_state_check" CHECK (
    NOT ("accepted_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
  )
);

CREATE INDEX "platform_organization_invitations_organization_created_idx"
  ON "platform_organization_invitations"("organization_id", "created_at");
CREATE INDEX "platform_organization_invitations_email_expiry_idx"
  ON "platform_organization_invitations"("email", "expires_at");
CREATE UNIQUE INDEX "platform_organization_invitations_pending_email_key"
  ON "platform_organization_invitations"("organization_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "platform_organization_invitations"
  ADD CONSTRAINT "platform_organization_invitations_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "platform_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_organization_invitations"
  ADD CONSTRAINT "platform_organization_invitations_accepted_by_user_id_fkey"
  FOREIGN KEY ("accepted_by_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
