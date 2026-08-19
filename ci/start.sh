#!/bin/sh
set -eu

echo "Loading Qasey secrets from AWS Secrets Manager..."
SECRET_ENV_CLI="node_modules/@moego/aws-secret-env/dist/esm/cli.mjs"
node "$SECRET_ENV_CLI" generate --default-environment testing

exec node "$SECRET_ENV_CLI" run --default-environment testing -- sh ci/runtime.sh "${1:-api}"
