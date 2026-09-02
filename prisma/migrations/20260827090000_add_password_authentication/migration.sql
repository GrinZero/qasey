CREATE TABLE "platform_password_credentials" (
  "user_id" UUID NOT NULL,
  "password_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_password_credentials_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "platform_password_credentials_hash_length_check"
    CHECK (char_length("password_hash") BETWEEN 32 AND 1024)
);

ALTER TABLE "platform_password_credentials"
  ADD CONSTRAINT "platform_password_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
