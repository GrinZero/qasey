#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [outputPath, serviceEvidenceDirectory, sandboxEvidenceDirectory] = process.argv.slice(2);
if (!outputPath || !serviceEvidenceDirectory || !sandboxEvidenceDirectory) {
  throw new Error("Usage: create-release-manifest.mjs <output> <service-evidence-dir> <sandbox-evidence-dir>");
}

const repository = requiredEnvironment("GITHUB_REPOSITORY");
const commit = requiredEnvironment("GITHUB_SHA");
const ref = requiredEnvironment("GITHUB_REF");
const serverUrl = requiredEnvironment("GITHUB_SERVER_URL").replace(/\/$/u, "");
const runId = requiredEnvironment("GITHUB_RUN_ID");
const runAttempt = requiredEnvironment("GITHUB_RUN_ATTEMPT");

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new Error("GITHUB_REPOSITORY is not a valid owner/repository identifier");
}
if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
  throw new Error("GITHUB_SHA must be a full Git commit hash");
}
if (!ref.startsWith("refs/")) throw new Error("GITHUB_REF must be a full Git ref");
if (!/^https:\/\/github\.com$/u.test(serverUrl)) throw new Error("Release evidence must originate from github.com");
if (!/^\d+$/u.test(runId) || !/^\d+$/u.test(runAttempt)) throw new Error("Workflow run identity is invalid");

const service = await readRoleEvidence("service", "service-runtime", serviceEvidenceDirectory, commit);
const sandbox = await readRoleEvidence("sandbox", "sandbox-runtime", sandboxEvidenceDirectory, commit);
const expectedServiceImage = `ghcr.io/${repository.toLowerCase()}`;
const expectedSandboxImage = `${expectedServiceImage}-sandbox`;
if (service.image !== expectedServiceImage) {
  throw new Error(`service evidence image must be ${expectedServiceImage}`);
}
if (sandbox.image !== expectedSandboxImage) {
  throw new Error(`sandbox evidence image must be ${expectedSandboxImage}`);
}

const manifest = {
  schemaVersion: 2,
  mediaType: "application/vnd.qasey.release-manifest.v2+json",
  source: {
    repository,
    commit,
    ref,
    workflowRun: `${serverUrl}/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
  },
  images: {
    service,
    sandbox,
  },
};
const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
const resolvedOutput = resolve(outputPath);
await mkdir(dirname(resolvedOutput), { recursive: true });
await writeFile(resolvedOutput, encoded, { mode: 0o644 });
await writeFile(`${resolvedOutput}.sha256`, `${createHash("sha256").update(encoded).digest("hex")}  ${resolvedOutput.split("/").at(-1)}\n`, { mode: 0o644 });

async function readRoleEvidence(role, expectedTarget, directory, expectedCommit) {
  const evidenceRoot = resolve(directory);
  const reference = (await readFile(resolve(evidenceRoot, "image-reference.txt"), "utf8")).trim();
  const sourceCommit = (await readFile(resolve(evidenceRoot, "source-commit.txt"), "utf8")).trim();
  const target = (await readFile(resolve(evidenceRoot, "target.txt"), "utf8")).trim();
  const match = /^(ghcr\.io\/[a-z0-9._/-]+)@(sha256:[a-f0-9]{64})$/u.exec(reference);
  if (!match) throw new Error(`${role} evidence does not contain a canonical GHCR digest reference`);
  if (sourceCommit !== expectedCommit) throw new Error(`${role} evidence was not built from GITHUB_SHA`);
  if (target !== expectedTarget) throw new Error(`${role} evidence used unexpected Docker target ${target}`);
  const evidence = {
    spdxSbom: await hashEvidenceFile(evidenceRoot, `${role}.spdx.json`),
    cyclonedxSbom: await hashEvidenceFile(evidenceRoot, `${role}.cyclonedx.json`),
    trivyVulnerabilityReport: await hashEvidenceFile(evidenceRoot, `${role}.trivy-vulnerabilities.json`),
  };
  return { target, image: match[1], digest: match[2], reference, evidence };
}

async function hashEvidenceFile(evidenceRoot, file) {
  const contents = await readFile(resolve(evidenceRoot, file));
  return {
    file,
    sha256: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
