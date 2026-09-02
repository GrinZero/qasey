#!/bin/sh
set -eu

migrate_database() {
  if [ "${NODE_ENV:-development}" = "production" ]; then
    if [ "${QASEY_DEPLOYMENT_MODE:-standalone}" = "distributed" ]; then
      return
    fi
    echo "Applying Prisma database migrations..."
    sh ci/migrate-database.sh
  fi
}

run_predeploy_migration() {
  if [ -z "${DATABASE_URL:-}" ]; then
    configuration_error "DATABASE_URL is required for the migration role"
  fi
  echo "Applying Prisma database migrations..."
  exec sh ci/migrate-database.sh
}

configuration_error() {
  echo "$1" >&2
  exit 78
}

configure_api_role() {
  if [ "${QASEY_DEPLOYMENT_MODE:-standalone}" != "distributed" ]; then
    return
  fi
  if [ -n "${MASTRA_WORKERS:-}" ] && [ "$MASTRA_WORKERS" != "false" ]; then
    configuration_error "Distributed API requires MASTRA_WORKERS=false"
  fi
  MASTRA_WORKERS=false
  export MASTRA_WORKERS
}

configure_worker_role() {
  if [ "${QASEY_DEPLOYMENT_MODE:-standalone}" != "distributed" ]; then
    configuration_error "Worker requires QASEY_DEPLOYMENT_MODE=distributed"
  fi
  if [ -n "${MASTRA_WORKERS:-}" ] && [ "$MASTRA_WORKERS" != "orchestration" ]; then
    configuration_error "Worker requires MASTRA_WORKERS=orchestration"
  fi
  MASTRA_WORKERS=orchestration
  export MASTRA_WORKERS

  if [ -z "${WORKER_TOKEN:-}" ]; then
    configuration_error "WORKER_TOKEN is required for the orchestration worker"
  fi
  if [ "${NODE_ENV:-development}" = "production" ] \
    && ! node -e 'process.exit(Buffer.byteLength(process.env.WORKER_TOKEN || "", "utf8") >= 32 ? 0 : 1)'; then
    configuration_error "WORKER_TOKEN must contain at least 32 UTF-8 bytes in production"
  fi
  if [ -z "${MASTRA_STEP_EXECUTION_URL:-}" ]; then
    configuration_error "MASTRA_STEP_EXECUTION_URL is required for the orchestration worker"
  fi
  if ! node -e '
    const value = process.env.MASTRA_STEP_EXECUTION_URL;
    let url;
    try { url = new URL(value); } catch { process.exit(1); }
    if (url.username || url.password) process.exit(1);
    if (url.protocol === "https:") process.exit(0);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    process.exit(process.env.NODE_ENV !== "production" && url.protocol === "http:" && local ? 0 : 1);
  '; then
    configuration_error "MASTRA_STEP_EXECUTION_URL must use HTTPS (development and test may use local HTTP)"
  fi

  if [ -n "${MASTRA_WORKER_AUTH_TOKEN:-}" ] && [ "$MASTRA_WORKER_AUTH_TOKEN" != "$WORKER_TOKEN" ]; then
    configuration_error "MASTRA_WORKER_AUTH_TOKEN must match WORKER_TOKEN"
  fi
  if [ "${NODE_ENV:-development}" = "production" ] \
    && [ -z "${QASEY_WORKER_METRICS_TOKEN:-}" ]; then
    configuration_error "QASEY_WORKER_METRICS_TOKEN is required for the production worker"
  fi
  # Mastra's HTTP remote strategy reads its standard variable. Qasey uses
  # the same secret to authenticate that worker at the API boundary.
  MASTRA_WORKER_AUTH_TOKEN="${MASTRA_WORKER_AUTH_TOKEN:-$WORKER_TOKEN}"
  export MASTRA_WORKER_AUTH_TOKEN
}

case "${1:-api}" in
  api)
    configure_api_role
    migrate_database
    if [ "${NODE_ENV:-development}" = "production" ]; then
      PORT="${PORT:-8080}"
    else
      PORT="${PORT:-4111}"
    fi
    # Studio is served behind the same public origin as its API. Default to
    # browser-origin discovery so first-time visitors are not sent to the
    # container-local host and port configuration screen.
    MASTRA_AUTO_DETECT_URL="${MASTRA_AUTO_DETECT_URL:-true}"
    export PORT MASTRA_AUTO_DETECT_URL
    exec node .mastra/output/index.mjs
    ;;
  worker)
    configure_worker_role
    migrate_database
    exec node dist/worker-supervisor.mjs
    ;;
  migrate)
    run_predeploy_migration
    ;;
  *)
    echo "Unknown Qasey process: $1" >&2
    exit 64
    ;;
esac
