#!/bin/sh
set -eu

remote=${1:-origin}
mode=${2:-}
release_ref=${GITHUB_REF:-}
expected_sha=${GITHUB_SHA:-}

case "$mode" in
  --record-github-output|--verify-baseline) ;;
  *)
    echo "usage: verify-release-ref.sh <remote> <--record-github-output|--verify-baseline>" >&2
    exit 64
    ;;
esac

case "$release_ref" in
  refs/heads/*|refs/tags/v*) ;;
  *)
    echo "release ref must be a branch or v* tag" >&2
    exit 64
    ;;
esac
if ! git check-ref-format "$release_ref" >/dev/null 2>&1; then
  echo "GITHUB_REF is not a valid full Git ref" >&2
  exit 64
fi
case "$expected_sha" in
  ""|*[!0-9a-f]*)
    echo "GITHUB_SHA must be a full Git commit hash" >&2
    exit 64
    ;;
esac
if [ "${#expected_sha}" -ne 40 ] && [ "${#expected_sha}" -ne 64 ]; then
  echo "GITHUB_SHA must be a full Git commit hash" >&2
  exit 64
fi

remote_refs=$(git ls-remote --exit-code "$remote" "$release_ref" "${release_ref}^{}") || {
  echo "remote release ref no longer exists: $release_ref" >&2
  exit 1
}

direct_sha=$(printf '%s\n' "$remote_refs" | awk -v ref="$release_ref" '$2 == ref { print $1 }')
peeled_sha=$(printf '%s\n' "$remote_refs" | awk -v ref="${release_ref}^{}" '$2 == ref { print $1 }')
if [ "$(printf '%s\n' "$direct_sha" | sed '/^$/d' | wc -l | tr -d ' ')" -gt 1 ] ||
   [ "$(printf '%s\n' "$peeled_sha" | sed '/^$/d' | wc -l | tr -d ' ')" -gt 1 ]; then
  echo "remote release ref resolved ambiguously: $release_ref" >&2
  exit 1
fi
is_full_hash() {
  value=$1
  case "$value" in
    ""|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#value}" -eq 40 ] || [ "${#value}" -eq 64 ]
}
if ! is_full_hash "$direct_sha" || { [ -n "$peeled_sha" ] && ! is_full_hash "$peeled_sha"; }; then
  echo "remote release ref returned an invalid object id" >&2
  exit 1
fi

# Annotated tags resolve through the peeled ^{} record. Lightweight tags and
# branches expose only the direct record.
remote_sha=${peeled_sha:-$direct_sha}
if [ -z "$remote_sha" ] || [ "$remote_sha" != "$expected_sha" ]; then
  echo "remote release ref moved: $release_ref expected $expected_sha, got ${remote_sha:-missing}" >&2
  exit 1
fi

peeled_record=${peeled_sha:--}
if [ "$mode" = "--record-github-output" ]; then
  if [ -z "${GITHUB_OUTPUT:-}" ]; then
    echo "GITHUB_OUTPUT is required when recording the release ref" >&2
    exit 64
  fi
  {
    printf 'release_ref=%s\n' "$release_ref"
    printf 'direct_sha=%s\n' "$direct_sha"
    printf 'peeled_sha=%s\n' "$peeled_record"
  } >> "$GITHUB_OUTPUT"
else
  baseline_ref=${QASEY_RELEASE_REF_BASELINE:-}
  baseline_direct=${QASEY_RELEASE_DIRECT_SHA_BASELINE:-}
  baseline_peeled=${QASEY_RELEASE_PEELED_SHA_BASELINE:-}
  if [ "$baseline_ref" != "$release_ref" ] ||
     [ "$baseline_direct" != "$direct_sha" ] ||
     [ "$baseline_peeled" != "$peeled_record" ]; then
    echo "remote release ref identity changed after initial verification" >&2
    exit 1
  fi
fi

printf 'Verified remote release ref %s at %s (direct %s, peeled %s)\n' \
  "$release_ref" "$expected_sha" "$direct_sha" "$peeled_record"
