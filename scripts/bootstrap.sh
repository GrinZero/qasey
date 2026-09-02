#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the local PostgreSQL and Redis services." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from the redacted template."
fi

corepack enable
corepack pnpm install --frozen-lockfile
docker compose up -d --wait postgres redis
corepack pnpm db:migrate:deploy

echo "Qasey infrastructure is ready. Run: pnpm dev"
