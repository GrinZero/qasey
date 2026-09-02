# Public release procedure

The extraction branch descends from a private repository that historically
tracked deployment configuration and tenant-derived fixtures. Removing those
files in a later commit does not remove their blobs from Git history. **Never
push this branch, its tags, or its ancestors to the public remote.**

## 1. Rotate and review

Before publication, the rights holder must:

1. rotate any credential that ever appeared in the private repository;
2. confirm the approved project name and Apache License 2.0 remain unchanged;
3. run `pnpm check` and `pnpm check:open-source` from this branch; and
4. review the staged public file list with `git status --short`.

The scanner is a release gate, not evidence that historical credentials remain
safe. Rotation is still required.

## 2. Create a disconnected public repository

Choose a new, nonexistent directory outside this checkout:

```bash
pnpm public:snapshot -- /absolute/path/to/qasey-public
```

The command copies only non-ignored files present in the current worktree,
creates a new Git repository with one root commit, and writes a
`.public-origin` marker into that root. It does not copy `.git`, ignored runtime
configuration, deleted files, or any ancestor commit.

The command requires an existing parent directory and refuses an existing
destination, a relative path, or a destination that resolves through symlinks
inside the private checkout. This protects both repositories from accidental
overwrite and recursive copying.

## 3. Verify the generated repository

Run all release gates from the generated directory:

```bash
cd /absolute/path/to/qasey-public
pnpm check:public-history
pnpm install --frozen-lockfile
pnpm check
docker build --target service-runtime -t qasey-service:release .
docker build --target sandbox-runtime -t qasey-sandbox:release .
```

Apply migrations to a disposable PostgreSQL 17 database and start the service
image in standalone mode. Confirm its `/healthz` and `/readyz`; start the
sandbox image with synthetic non-secret CI configuration and confirm its own
probes. The CI workflow repeats source, migration, build, role-boundary, and
both image checks on the public repository.

## 4. Publish without reconnecting private history

Create an empty public repository, add it as the generated snapshot's first
remote, and push `main`. Do not add the public remote to the private checkout,
merge the extraction branch, force-push old refs, or mirror tags. Future public
development starts from the sanitized root.

Keep the private-to-public mapping in the release ticket or another private
system, not in the public repository.

## 5. Publish immutable container releases

After development has moved to the disconnected public repository,
`.github/workflows/release.yml` publishes the trusted service image to
`ghcr.io/<owner>/<repository>` and the untrusted execution image to
`ghcr.io/<owner>/<repository>-sandbox`. It runs only for a `v*` tag contained
in the protected default-branch history or an explicit dispatch from that
default branch or such a tag. Repository settings must protect the default
branch. A GitHub tag Ruleset targeting `refs/tags/v*` must prohibit updates
and deletions so a release identity cannot be retargeted or removed after the
workflow starts. The real public repository's protected default-branch rules
and this tag Ruleset are external GA gates: repository files can document and
probe them, but cannot establish that the hosted settings are enabled. Record
their manual/API verification in the release ticket before the first production
release. The workflow independently fails closed on every other ref. It runs
`pnpm check` before release, and it requires already-successful `ci.yml` and
`security.yml` runs for the exact source commit so image role/probe, secret,
lockfile vulnerability, license, and CodeQL gates cannot be bypassed by a tag
race. The check job records the remote ref's direct object and, for annotated
tags, its peeled commit as immutable job outputs. Immediately before GHCR
authentication and after each digest publication, the release job resolves
`GITHUB_REF` again with `git ls-remote`, requires the resolved commit to remain
`GITHUB_SHA`, and requires both object identities to match the initial record.
This catches replacement annotated tag objects even when they peel to the same
commit. It uses no organization-specific registry path or secret.

One two-phase release job builds each Docker target once as a local OCI archive,
safely validates and extracts both layouts, and imports those exact digests into
a pinned ephemeral local registry. Before scanning or external publication, the
service candidate must migrate/start against PostgreSQL and pass its probes; the
Sandbox candidate must pass artifact/role checks, a real bubblewrap isolation
claim, and a sandboxed Chromium frame smoke. The job then generates per-image
SPDX JSON and CycloneDX JSON SBOMs. Both HIGH/CRITICAL Trivy gates must pass
before the workflow logs in to GHCR or publishes either image. The validated
blobs and manifests are uploaded directly under their OCI digests without
creating a registry tag. A final source-free job publishes GitHub
provenance and both SBOM attestations and adds a keyless Cosign signature to
each digest. All actions and helper container images are pinned to immutable
SHAs/digests. The OIDC token is available only to that final attestation job,
which neither checks out nor executes repository source.

The per-role evidence artifacts contain the canonical references:

```text
ghcr.io/owner/repository@sha256:<service-digest>
ghcr.io/owner/repository-sandbox@sha256:<sandbox-digest>
```

Each role artifact also contains both SBOMs and its Trivy JSON report. A
deterministic `release-manifest.json` binds the two references, Docker targets,
repository, source commit, ref, workflow run, and the SHA-256 of each role's
SPDX SBOM, CycloneDX SBOM, and Trivy vulnerability report. The manifest receives a
GitHub artifact attestation and keyless Cosign blob signature. The workflow
intentionally publishes no `latest`, version, commit, or temporary registry
tag. Before signing, each role's source-free attestation job recomputes those
hashes and requires the manifest reference, digest, target, source identity, and
expected repository-owned image name to match its downloaded evidence. Promote
the signed manifest as the release unit and copy both canonical
`name@sha256:digest` values into role-specific deployment configuration; never
resolve a mutable tag during deployment.

Verify the GitHub provenance with GitHub CLI, replacing the placeholders with
the public repository and emitted digest:

```bash
gh attestation verify \
  oci://ghcr.io/OWNER/REPOSITORY@sha256:SERVICE_DIGEST \
  --repo OWNER/REPOSITORY
gh attestation verify \
  oci://ghcr.io/OWNER/REPOSITORY-sandbox@sha256:SANDBOX_DIGEST \
  --repo OWNER/REPOSITORY
```

For a tag-triggered release, verify the keyless signature against the exact
workflow identity and tag:

```bash
cosign verify \
  --certificate-identity \
    https://github.com/OWNER/REPOSITORY/.github/workflows/release.yml@refs/tags/VERSION_TAG \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/OWNER/REPOSITORY@sha256:SERVICE_DIGEST

cosign verify \
  --certificate-identity \
    https://github.com/OWNER/REPOSITORY/.github/workflows/release.yml@refs/tags/VERSION_TAG \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/OWNER/REPOSITORY-sandbox@sha256:SANDBOX_DIGEST
```

For a manual dispatch, replace the identity suffix with the exact selected
branch or tag ref recorded by that workflow run. Lowercase `OWNER/REPOSITORY`
in the GHCR image path; GitHub repository names themselves may contain uppercase
characters.
