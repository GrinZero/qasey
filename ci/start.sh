#!/bin/sh
set -eu

exec sh ci/runtime.sh "${1:-api}"
