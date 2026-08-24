#!/bin/sh
set -eu

case "${1:-api}" in
  api)
    if [ "${NODE_ENV:-development}" = "production" ]; then
      PORT=8080
    else
      PORT=4111
    fi
    # Studio is served behind the same public origin as its API. Default to
    # browser-origin discovery so first-time visitors are not sent to the
    # container-local host and port configuration screen.
    MASTRA_AUTO_DETECT_URL="${MASTRA_AUTO_DETECT_URL:-true}"
    export PORT MASTRA_AUTO_DETECT_URL
    exec node .mastra/output/index.mjs
    ;;
  worker)
    : "${MASTRA_WORKER_AUTH_TOKEN:?MASTRA_WORKER_AUTH_TOKEN is required for the orchestration worker}"
    exec node .mastra/worker/index.mjs
    ;;
  sandbox)
    exec node dist/sandbox-runtime.mjs
    ;;
  *)
    echo "Unknown Qasey process: $1" >&2
    exit 64
    ;;
esac
