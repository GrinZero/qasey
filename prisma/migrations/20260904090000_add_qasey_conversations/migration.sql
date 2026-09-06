CREATE TABLE "qasey_conversations" (
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "subject_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "active_turn_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qasey_conversations_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);

CREATE TABLE "qasey_conversation_turns" (
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "client_message_id" UUID NOT NULL,
    "user_message" TEXT NOT NULL,
    "assistant_text" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "event_sequence" INTEGER NOT NULL DEFAULT 0,
    "agent_run_id" UUID,
    "linked_run_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qasey_conversation_turns_pkey" PRIMARY KEY ("application_id", "tenant_id", "id")
);

CREATE TABLE "qasey_conversation_events" (
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "turn_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qasey_conversation_events_pkey" PRIMARY KEY ("application_id", "tenant_id", "turn_id", "sequence")
);

CREATE INDEX "qasey_conversations_owner_idx" ON "qasey_conversations"("application_id", "tenant_id", "subject_id", "updated_at" DESC);
CREATE UNIQUE INDEX "qasey_conversation_turns_client_message_key" ON "qasey_conversation_turns"("application_id", "tenant_id", "conversation_id", "client_message_id");
CREATE INDEX "qasey_conversation_turns_conversation_idx" ON "qasey_conversation_turns"("application_id", "tenant_id", "conversation_id", "created_at");
CREATE INDEX "qasey_conversation_turns_stale_idx" ON "qasey_conversation_turns"("status", "updated_at");
CREATE INDEX "qasey_conversation_events_replay_idx" ON "qasey_conversation_events"("application_id", "tenant_id", "conversation_id", "turn_id", "sequence");

-- Earlier proposal creation updated the denormalized Case title and suite before
-- approval. Restore formal library metadata from the active version.
UPDATE "qasey_cases" AS c
SET "title" = v."payload"->>'title',
    "suite_path" = v."payload"->>'suitePath',
    "payload" = jsonb_set(
      jsonb_set(c."payload", '{title}', to_jsonb(v."payload"->>'title')),
      '{suitePath}', to_jsonb(v."payload"->>'suitePath')
    )
FROM "qasey_case_versions" AS v
WHERE c."active_version_id" = v."id"
  AND c."application_id" = v."application_id"
  AND c."tenant_id" = v."tenant_id";
