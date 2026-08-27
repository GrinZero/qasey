#!/bin/sh
set -eu

configuration_error() {
  echo "$1" >&2
  exit 78
}

if [ "$#" -gt 1 ] || [ "${1:-sandbox}" != "sandbox" ]; then
  echo "sandbox-runtime only supports the sandbox process" >&2
  exit 64
fi

if [ "${NODE_ENV:-development}" = "production" ]; then
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    configuration_error "Sandbox authoring requires OPENAI_API_KEY"
  fi
  if [ -z "${QASEY_SANDBOX_CONTROL_KEY:-}" ]; then
    configuration_error "QASEY_SANDBOX_CONTROL_KEY is required for the production sandbox"
  fi
fi

exec node dist/sandbox-runtime.mjs
