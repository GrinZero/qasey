import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "../..");
let workflow = "";
let refVerifier = "";
let sandboxSmoke = "";

beforeAll(async () => {
  [workflow, refVerifier, sandboxSmoke] = await Promise.all([
    readFile(resolve(projectRoot, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(projectRoot, "ci/verify-release-ref.sh"), "utf8"),
    readFile(resolve(projectRoot, "ci/smoke-sandbox-runtime.mjs"), "utf8"),
  ]);
});

describe("immutable split-image release workflow", () => {
  it("fails closed unless the source is the default branch or a v* tag in its history", () => {
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(3);
    expect(workflow).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain('"refs/heads/${DEFAULT_BRANCH}"');
    expect(workflow).toContain("refs/tags/v*)");
    expect(workflow).toContain('git merge-base --is-ancestor "$tag_commit" "refs/remotes/origin/${DEFAULT_BRANCH}"');
    expect(workflow).toContain("workflow_dispatch is restricted to the default branch or a v* tag");
    expect(workflow).toContain("name: Require successful exact-commit CI and security gates");
    expect(workflow).toContain("actions/workflows/${workflow}/runs?head_sha=${GITHUB_SHA}&status=completed");
    expect(workflow).toContain("require_workflow ci.yml");
    expect(workflow).toContain("require_workflow security.yml");
    expect(workflow).toContain('.event == "push"');
    expect(workflow).toContain(".head_branch == $branch");
    expect(workflow).toContain("No successful ${workflow} default-branch push run exists for GITHUB_SHA");
    expect(workflow).toContain("actions: read");

    const verifyIndex = workflow.indexOf("name: Verify default-branch or protected-history tag source");
    const ciGateIndex = workflow.indexOf("name: Require successful exact-commit CI and security gates");
    const installIndex = workflow.indexOf("name: Install dependencies");
    const projectCheckIndex = workflow.indexOf("name: Run project checks");
    const releaseIndex = workflow.indexOf("\n  release:");
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeLessThan(ciGateIndex);
    expect(ciGateIndex).toBeLessThan(installIndex);
    expect(projectCheckIndex).toBeLessThan(releaseIndex);
    expect(workflow.slice(projectCheckIndex, releaseIndex)).toContain("run: pnpm check");
    expect(workflow.slice(projectCheckIndex, releaseIndex)).toContain("run: pnpm test:browser");
    expect(workflow.slice(releaseIndex)).toContain("needs: check");
  });

  it("revalidates branch, lightweight-tag, and peeled annotated-tag refs against the remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-release-ref-"));
    const remote = join(root, "remote.git");
    const working = join(root, "working");
    const script = resolve(projectRoot, "ci/verify-release-ref.sh");
    try {
      await exec("git", ["init", "--quiet", "--bare", remote]);
      await exec("git", ["init", "--quiet", "--initial-branch=main", working]);
      await exec("git", ["-C", working, "config", "user.name", "Qasey Release Test"]);
      await exec("git", ["-C", working, "config", "user.email", "release@example.invalid"]);
      await writeFile(join(working, "release.txt"), "first\n");
      await exec("git", ["-C", working, "add", "release.txt"]);
      await exec("git", ["-C", working, "commit", "--quiet", "-m", "first"]);
      const first = (await exec("git", ["-C", working, "rev-parse", "HEAD"])).stdout.trim();
      await exec("git", ["-C", working, "tag", "v-lightweight"]);
      await exec("git", ["-C", working, "tag", "--annotate", "v-annotated", "--message", "annotated"]);
      await exec("git", ["-C", working, "push", "--quiet", remote, "main", "refs/tags/v-lightweight", "refs/tags/v-annotated"]);

      const baselines = new Map<string, Record<string, string>>();
      for (const ref of ["refs/heads/main", "refs/tags/v-lightweight", "refs/tags/v-annotated"]) {
        const output = join(root, `${ref.split("/").at(-1)}.output`);
        await writeFile(output, "");
        const result = await exec("sh", [script, remote, "--record-github-output"], {
          env: { ...process.env, GITHUB_REF: ref, GITHUB_SHA: first, GITHUB_OUTPUT: output },
        });
        expect(result.stdout).toContain(`Verified remote release ref ${ref} at ${first}`);
        const baseline = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map(line => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }));
        baselines.set(ref, baseline);
        await exec("sh", [script, remote, "--verify-baseline"], {
          env: baselineEnvironment(ref, first, baseline),
        });
      }

      await exec("git", ["-C", working, "tag", "--force", "--annotate", "v-annotated", "--message", "replacement annotation", first]);
      await exec("git", ["-C", working, "push", "--quiet", "--force", remote, "refs/tags/v-annotated"]);
      await expect(exec("sh", [script, remote, "--verify-baseline"], {
        env: baselineEnvironment("refs/tags/v-annotated", first, baselines.get("refs/tags/v-annotated") ?? {}),
      })).rejects.toThrow(/remote release ref identity changed after initial verification/u);

      await writeFile(join(working, "release.txt"), "second\n");
      await exec("git", ["-C", working, "add", "release.txt"]);
      await exec("git", ["-C", working, "commit", "--quiet", "-m", "second"]);
      await exec("git", ["-C", working, "tag", "--force", "v-lightweight"]);
      await exec("git", ["-C", working, "push", "--quiet", "--force", remote, "refs/tags/v-lightweight"]);
      await expect(exec("sh", [script, remote, "--verify-baseline"], {
        env: baselineEnvironment("refs/tags/v-lightweight", first, baselines.get("refs/tags/v-lightweight") ?? {}),
      })).rejects.toThrow(/remote release ref moved/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins every action and grants OIDC only to the source-free attestation job", () => {
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s+\S+@([^\s]+)(?:\s+#.*)?$/gmu)]
      .map(([, reference]) => reference)
      .filter((reference): reference is string => Boolean(reference));
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every(reference => /^[a-f0-9]{40}$/u.test(reference))).toBe(true);
    expect(workflow.match(/id-token: write/gu)).toHaveLength(1);
    expect(workflow.match(/packages: write/gu)).toHaveLength(2);
    expect(workflow.match(/attestations: write/gu)).toHaveLength(1);
    expect(workflow).not.toMatch(/(?:contents|actions|security-events): write/u);

    const attestJob = workflow.slice(workflow.indexOf("\n  attest:"));
    expect(attestJob).toContain("needs: [release, manifest]");
    expect(attestJob).toContain("id-token: write");
    expect(attestJob).not.toContain("actions/checkout@");
    expect(attestJob).not.toContain("docker/build-push-action@");
    expect(attestJob).not.toContain("aquasecurity/trivy-action@");
    expect(workflow.slice(workflow.indexOf("\n  release:"), workflow.indexOf("\n  attest:"))).not.toContain("id-token: write");
  });

  it("builds and scans both role targets before publishing either digest", () => {
    expect(workflow).toContain("target: service-runtime");
    expect(workflow).toContain("target: sandbox-runtime");
    expect(workflow).toContain("sandbox=ghcr.io/%s-sandbox");
    expect(workflow).toContain("outputs: type=oci,dest=${{ runner.temp }}/service.oci.tar");
    expect(workflow).toContain("outputs: type=oci,dest=${{ runner.temp }}/sandbox.oci.tar");
    expect(workflow).toContain("input: ${{ runner.temp }}/service.oci.tar");
    expect(workflow).toContain("input: ${{ runner.temp }}/sandbox.oci.tar");
    expect(workflow).toContain("ghcr.io/oras-project/oras:v1.3.0@sha256:6ce045ce069a89934d6666b8b49f9c4c0145201bd6de6dbe2aee267814c55468");
    expect(workflow.match(/sh ci\/extract-oci-layout\.sh "\$OCI_ARCHIVE" "\$OCI_LAYOUT"/gu)).toHaveLength(2);
    expect(workflow).toContain('manifest fetch --oci-layout --output /dev/null "/release@${DIGEST}"');
    expect(workflow.match(/node ci\/publish-oci-layout-by-digest\.mjs/gu)).toHaveLength(4);
    expect(workflow).toContain('"$OCI_LAYOUT" "$IMAGE" "$DIGEST"');
    expect(workflow).not.toContain("content_tag");
    expect(workflow).not.toMatch(/\$\{IMAGE\}:\$\{/u);
    expect(workflow).toContain('docker buildx imagetools inspect "${IMAGE}@${DIGEST}"');
    expect(workflow).not.toContain("push: true");
    expect(workflow).not.toMatch(/\bdocker\s+push\b/u);
    expect(workflow).not.toContain(":latest");

    const orderedMarkers = [
      "name: Build service immutable OCI layout",
      "name: Build sandbox immutable OCI layout",
      "name: Smoke exact service candidate from its OCI digest",
      "name: Smoke exact sandbox candidate and bwrap browser boundary",
      "name: Gate service HIGH and CRITICAL vulnerabilities",
      "name: Gate sandbox HIGH and CRITICAL vulnerabilities",
      "name: Assert both vulnerability gates passed before publication",
      "name: Log in to GHCR after both vulnerability gates",
      "name: Publish scanned service OCI layout by digest",
      "name: Publish scanned sandbox OCI layout by digest",
      "name: Attest image provenance",
      "name: Sign image by digest",
    ];
    const positions = orderedMarkers.map(marker => workflow.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    const firstRegistryLogin = workflow.indexOf("name: Log in to GHCR");
    const firstRegistryPush = workflow.indexOf("name: Publish scanned");
    expect(firstRegistryLogin).toBeGreaterThan(workflow.indexOf("name: Gate sandbox HIGH and CRITICAL vulnerabilities"));
    expect(firstRegistryPush).toBeGreaterThan(workflow.indexOf("name: Gate sandbox HIGH and CRITICAL vulnerabilities"));
    expect(workflow.slice(workflow.indexOf("\n  release:"), firstRegistryLogin)).toContain("steps.scan_service.outcome");
    expect(workflow.slice(workflow.indexOf("\n  release:"), firstRegistryLogin)).toContain("steps.scan_sandbox.outcome");
    expect(workflow).toContain("postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73");
    expect(workflow).toContain("registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373");
    expect(workflow).toContain("localhost:5005/qasey-service-candidate@${DIGEST}");
    expect(workflow).toContain("localhost:5005/qasey-sandbox-candidate@${DIGEST}");
    expect(workflow).toContain("node ci/smoke-sandbox-runtime.mjs");
    expect(workflow).toContain("QASEY_SANDBOX_ISOLATION=bwrap");
    expect(workflow).toContain("--cap-drop ALL");
    expect(workflow).toContain("--security-opt no-new-privileges");
    expect(workflow).toContain("--security-opt seccomp=unconfined");
    expect(workflow).toContain("--security-opt systempaths=unconfined");
    expect(workflow).toContain("--security-opt apparmor=unconfined");
    expect(workflow).not.toContain("--privileged");
    expect(workflow).not.toContain("--cap-add SYS_ADMIN");
    for (const option of [
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--security-opt seccomp=unconfined",
      "--security-opt systempaths=unconfined",
      "--security-opt apparmor=unconfined",
    ]) {
      expect(workflow.split(option)).toHaveLength(2);
    }
    const serviceSmoke = workflow.slice(
      workflow.indexOf("name: Smoke exact service candidate from its OCI digest"),
      workflow.indexOf("name: Smoke exact sandbox candidate and bwrap browser boundary"),
    );
    const sandboxSmokeStep = workflow.slice(
      workflow.indexOf("name: Smoke exact sandbox candidate and bwrap browser boundary"),
      workflow.indexOf("name: Generate service SPDX JSON SBOM"),
    );
    expect(serviceSmoke).not.toContain("--security-opt seccomp=unconfined");
    expect(serviceSmoke).not.toContain("--security-opt systempaths=unconfined");
    expect(serviceSmoke).not.toContain("--security-opt apparmor=unconfined");
    expect(sandboxSmokeStep).toContain("--security-opt seccomp=unconfined");
    expect(sandboxSmokeStep).toContain("--security-opt systempaths=unconfined");
    expect(sandboxSmokeStep).toContain("--security-opt apparmor=unconfined");
    expect(sandboxSmokeStep).toContain("printf host-device > /dev/qasey-host-device-sentinel");
    expect(sandboxSmokeStep).toContain('test "$(cat /dev/qasey-host-device-sentinel)" = host-device');
    expect(sandboxSmokeStep).toContain("packageManager");
    expect(sandboxSmokeStep).toContain("pnpm install --lockfile-only --ignore-scripts");
    expect(sandboxSmokeStep).toContain("git add isolation.spec.js package.json pnpm-lock.yaml");
    expect(sandboxSmokeStep).toContain("ps -eo stat=,ppid=,pid=,comm=");
    expect(sandboxSmokeStep).toContain("live sandbox descendants remain after stop");
    expect(sandboxSmokeStep).toContain('QASEY_IMAGE_DIGEST=${DIGEST}');
    expect(workflow).toContain('ln -s /tmp/qasey-host-sentinel "$browser/latest.jpg"');
    expect(workflow).toContain('test "$(cat /tmp/qasey-host-sentinel)" = host-secret');
    expect(workflow).toContain('test ! -L "$latest"');
    expect(sandboxSmoke).toContain("generic namespace after browser");
    expect(sandboxSmoke).toContain("`/tmp/qasey-data/browser/${workspaceId}`");
    expect(sandboxSmoke).toContain("`/tmp/qasey-data/code-tasks/${workspaceId}`");
    expect(sandboxSmoke).toContain('expectOk("stop sandbox session"');
    expect(sandboxSmoke).toContain('expectOk("capacity after stop"');
    expect(sandboxSmoke).toContain("taskState.result?.provenance?.imageDigest !== expectedImageDigest");
    expect(workflow).toContain("severity: HIGH,CRITICAL");
    expect(workflow).toContain('exit-code: "1"');
    expect(workflow.match(/run: sh ci\/verify-release-ref\.sh origin --verify-baseline/gu)).toHaveLength(3);
    expect(workflow).toContain("name: Record immutable remote release ref identity");
    expect(workflow).toContain("release_ref: ${{ steps.remote_ref.outputs.release_ref }}");
    expect(workflow).toContain("QASEY_RELEASE_DIRECT_SHA_BASELINE: ${{ needs.check.outputs.direct_sha }}");
    expect(workflow).toContain("QASEY_RELEASE_PEELED_SHA_BASELINE: ${{ needs.check.outputs.peeled_sha }}");
    expect(workflow.match(/--verify-baseline/gu)).toHaveLength(3);
    expect(workflow).toContain("name: Reverify remote release ref before registry authentication");
    expect(workflow).toContain("name: Reverify remote release ref after service digest publication");
    expect(workflow).toContain("name: Reverify remote release ref after sandbox digest publication");
    expect(refVerifier).toContain('git ls-remote --exit-code "$remote" "$release_ref" "${release_ref}^{}"');

    const prePublishRefCheck = workflow.indexOf("name: Reverify remote release ref before registry authentication");
    const serviceRefCheck = workflow.indexOf("name: Reverify remote release ref after service digest publication");
    const sandboxRefCheck = workflow.indexOf("name: Reverify remote release ref after sandbox digest publication");
    expect(prePublishRefCheck).toBeGreaterThan(workflow.indexOf("name: Assert both vulnerability gates passed before publication"));
    expect(prePublishRefCheck).toBeLessThan(firstRegistryLogin);
    expect(serviceRefCheck).toBeGreaterThan(workflow.indexOf("name: Publish scanned service OCI layout by digest"));
    expect(serviceRefCheck).toBeLessThan(workflow.indexOf("name: Publish scanned sandbox OCI layout by digest"));
    expect(sandboxRefCheck).toBeGreaterThan(workflow.indexOf("name: Publish scanned sandbox OCI layout by digest"));
  });

  it("attests and signs each digest plus the commit-bound release manifest", () => {
    expect(workflow).toContain("role: [service, sandbox]");
    expect(workflow).toContain("subject-name: ${{ steps.subject.outputs.image }}");
    expect(workflow).toContain("subject-digest: ${{ steps.subject.outputs.digest }}");
    expect(workflow).toContain("sbom-path: release-evidence/${{ matrix.role }}.spdx.json");
    expect(workflow).toContain("sbom-path: release-evidence/${{ matrix.role }}.cyclonedx.json");
    expect(workflow.match(/create-storage-record: false/gu)).toHaveLength(3);
    expect(workflow).toContain('cosign sign --yes "${IMAGE}@${DIGEST}"');
    expect(workflow).toContain("node ci/create-release-manifest.mjs");
    expect(workflow).toContain("name: Resolve scanned subject and verify release manifest evidence");
    expect(workflow).toContain(".images[$role].reference == $reference");
    expect(workflow).toContain("verify_evidence spdxSbom");
    expect(workflow).toContain("verify_evidence cyclonedxSbom");
    expect(workflow).toContain("verify_evidence trivyVulnerabilityReport");
    expect(workflow).toContain('sha256sum "release-evidence/$file"');
    expect(workflow).toContain("cosign sign-blob --yes");
    expect(workflow).toContain("name: signed-release-manifest");
  });

  it("generates a deterministic manifest only from same-commit role evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-release-manifest-"));
    const service = join(root, "service");
    const sandbox = join(root, "sandbox");
    const output = join(root, "release", "release-manifest.json");
    const commit = "a".repeat(40);
    try {
      await Promise.all([
        writeEvidence(service, "ghcr.io/example/qasey@sha256:" + "1".repeat(64), commit, "service-runtime"),
        writeEvidence(sandbox, "ghcr.io/example/qasey-sandbox@sha256:" + "2".repeat(64), commit, "sandbox-runtime"),
      ]);
      const env = {
        ...process.env,
        GITHUB_REPOSITORY: "example/qasey",
        GITHUB_SHA: commit,
        GITHUB_REF: "refs/tags/v1.0.0",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "2",
      };
      await exec(process.execPath, [resolve(projectRoot, "ci/create-release-manifest.mjs"), output, service, sandbox], { env });
      const manifest = JSON.parse(await readFile(output, "utf8")) as {
        schemaVersion: number;
        mediaType: string;
        source: { commit: string; workflowRun: string };
        images: {
          service: { target: string; digest: string; evidence: Record<string, { file: string; sha256: string }> };
          sandbox: { target: string; digest: string; evidence: Record<string, { file: string; sha256: string }> };
        };
      };
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.mediaType).toBe("application/vnd.qasey.release-manifest.v2+json");
      expect(manifest.source).toEqual({
        repository: "example/qasey",
        commit,
        ref: "refs/tags/v1.0.0",
        workflowRun: "https://github.com/example/qasey/actions/runs/1234/attempts/2",
      });
      expect(manifest.images.service).toMatchObject({ target: "service-runtime", digest: `sha256:${"1".repeat(64)}` });
      expect(manifest.images.sandbox).toMatchObject({ target: "sandbox-runtime", digest: `sha256:${"2".repeat(64)}` });
      expect(manifest.images.service.evidence).toEqual(expectedEvidence("service"));
      expect(manifest.images.sandbox.evidence).toEqual(expectedEvidence("sandbox"));
      expect(await readFile(`${output}.sha256`, "utf8")).toMatch(/^[a-f0-9]{64}  release-manifest\.json\n$/u);

      await writeFile(join(service, "image-reference.txt"), `ghcr.io/example/other@sha256:${"1".repeat(64)}\n`);
      await expect(exec(process.execPath, [resolve(projectRoot, "ci/create-release-manifest.mjs"), output, service, sandbox], { env }))
        .rejects.toThrow(/service evidence image must be ghcr\.io\/example\/qasey/u);
      await writeFile(join(service, "image-reference.txt"), `ghcr.io/example/qasey@sha256:${"1".repeat(64)}\n`);

      await writeFile(join(sandbox, "source-commit.txt"), `${"b".repeat(40)}\n`);
      await expect(exec(process.execPath, [resolve(projectRoot, "ci/create-release-manifest.mjs"), output, service, sandbox], { env }))
        .rejects.toThrow(/sandbox evidence was not built from GITHUB_SHA/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeEvidence(directory: string, reference: string, commit: string, target: string) {
  const role = target.replace(/-runtime$/u, "");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "image-reference.txt"), `${reference}\n`),
    writeFile(join(directory, "source-commit.txt"), `${commit}\n`),
    writeFile(join(directory, "target.txt"), `${target}\n`),
    ...Object.entries(evidenceFixtures(role)).map(([file, contents]) => writeFile(join(directory, file), contents)),
  ]);
}

function expectedEvidence(role: string) {
  const fixtures = evidenceFixtures(role);
  return {
    spdxSbom: evidenceDigest(`${role}.spdx.json`, fixtures[`${role}.spdx.json`] ?? ""),
    cyclonedxSbom: evidenceDigest(`${role}.cyclonedx.json`, fixtures[`${role}.cyclonedx.json`] ?? ""),
    trivyVulnerabilityReport: evidenceDigest(
      `${role}.trivy-vulnerabilities.json`,
      fixtures[`${role}.trivy-vulnerabilities.json`] ?? "",
    ),
  };
}

function evidenceFixtures(role: string) {
  return {
    [`${role}.spdx.json`]: `${JSON.stringify({ role, format: "spdx" })}\n`,
    [`${role}.cyclonedx.json`]: `${JSON.stringify({ role, format: "cyclonedx" })}\n`,
    [`${role}.trivy-vulnerabilities.json`]: `${JSON.stringify({ role, findings: [] })}\n`,
  };
}

function evidenceDigest(file: string, contents: string) {
  return { file, sha256: `sha256:${createHash("sha256").update(contents).digest("hex")}` };
}

function baselineEnvironment(ref: string, sha: string, baseline: Record<string, string>) {
  return {
    ...process.env,
    GITHUB_REF: ref,
    GITHUB_SHA: sha,
    QASEY_RELEASE_REF_BASELINE: baseline.release_ref,
    QASEY_RELEASE_DIRECT_SHA_BASELINE: baseline.direct_sha,
    QASEY_RELEASE_PEELED_SHA_BASELINE: baseline.peeled_sha,
  };
}
