#!/bin/sh
set -eu

npx npm-cli-login \
  -u "$NPM_PUBLISHER_USR" \
  -p "$NPM_PUBLISHER_PSW" \
  -e devops@moego.pet \
  -r "https://nexus.devops.moego.pet/repository/npm-local/"

pnpm install --frozen-lockfile
