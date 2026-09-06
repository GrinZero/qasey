CREATE TABLE "conversation_collaboration" (
  "application_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "conversation_id" UUID NOT NULL,
  "subject_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "state" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("application_id", "tenant_id", "conversation_id"),
  FOREIGN KEY ("application_id", "tenant_id", "conversation_id")
    REFERENCES "qasey_conversations" ("application_id", "tenant_id", "id") ON DELETE CASCADE
);
CREATE INDEX "conversation_collaboration_updated_idx" ON "conversation_collaboration" ("updated_at");
