#!/bin/sh
set -eu

case "${1:-api}" in
  api)
    exec node .mastra/output/index.mjs
    ;;
  worker)
    : "${MASTRA_WORKER_AUTH_TOKEN:?MASTRA_WORKER_AUTH_TOKEN is required for the orchestration worker}"
    exec node .mastra/worker/index.mjs
    ;;
  *)
    echo "Unknown Qasey process: $1" >&2
    exit 64
    ;;
esac
