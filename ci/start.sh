#!/bin/sh
set -eu

echo "Loading Qasey secrets from AWS Secrets Manager..."
pnpm exec moego-aws-secret-env generate --default-environment testing

exec pnpm exec moego-aws-secret-env run --default-environment testing -- sh ci/runtime.sh "${1:-api}"
