#!/bin/sh
set -eu

prisma_cli="node_modules/prisma/build/index.js"
baseline_name="20260824133000_baseline_application_database"
baseline_sql="prisma/migrations/$baseline_name/migration.sql"

deploy_status=0
deploy_output="$(node "$prisma_cli" migrate deploy 2>&1)" || deploy_status=$?
printf '%s\n' "$deploy_output"

if [ "$deploy_status" -eq 0 ]; then
  exit 0
fi

case "$deploy_output" in
  *P3005*)
    echo "Adopting the existing application schema as the Prisma baseline..."
    # Never infer that an old Qasey table is structurally complete from its
    # name. Existing application schemas require an explicit reviewed upgrade;
    # automatic adoption is reserved for Mastra-only databases.
    node ci/verify-baseline-adoption.mjs
    # The baseline SQL uses IF NOT EXISTS and duplicate-object guards so it can
    # safely initialize application tables before migration history is added.
    node "$prisma_cli" db execute --file "$baseline_sql"

    # API and worker pods can reach this branch concurrently. One resolve may
    # observe that the other already recorded the baseline; the final deploy is
    # the authoritative check and still fails for any unrelated resolve error.
    resolve_output="$(node "$prisma_cli" migrate resolve --applied "$baseline_name" 2>&1)" || true
    printf '%s\n' "$resolve_output"
    node "$prisma_cli" migrate deploy
    ;;
  *)
    exit "$deploy_status"
    ;;
esac
