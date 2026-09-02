#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const layout = resolve(args.shift() ?? "");
const image = args.shift() ?? "";
const rootDigest = args.shift() ?? "";
let registryConfig;
let plainHttp = false;
while (args.length > 0) {
  const option = args.shift();
  if (option === "--plain-http") plainHttp = true;
  else if (option === "--registry-config") registryConfig = resolve(args.shift() ?? "");
  else throw new Error(`Unknown option: ${option}`);
}

if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/u.test(image)) {
  throw new Error("Destination must be an untagged lowercase registry repository");
}
if (!/^sha256:[0-9a-f]{64}$/u.test(rootDigest)) throw new Error("Invalid root digest");
if (registryConfig) await access(registryConfig);
await Promise.all([access(`${layout}/oci-layout`), access(`${layout}/index.json`)]);

const orasImage = process.env.ORAS_IMAGE ??
  "ghcr.io/oras-project/oras:v1.3.0@sha256:6ce045ce069a89934d6666b8b49f9c4c0145201bd6de6dbe2aee267814c55468";
if (!/@sha256:[0-9a-f]{64}$/u.test(orasImage)) throw new Error("ORAS_IMAGE must be pinned by digest");

const indexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const imageManifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const manifestGraphMediaTypes = new Set([...indexMediaTypes, ...imageManifestMediaTypes]);
const configMediaTypes = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);
const layerMediaTypes = new Set([
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.oci.image.layer.v1.tar+zstd",
  "application/vnd.oci.image.layer.nondistributable.v1.tar",
  "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
  "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd",
  "application/vnd.docker.image.rootfs.diff.tar",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
  "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
]);

const blobDirectory = `${layout}/blobs/sha256`;
const blobNames = (await readdir(blobDirectory)).sort();
if (blobNames.some(name => !/^[0-9a-f]{64}$/u.test(name))) {
  throw new Error("OCI layout contains a non-sha256 blob name");
}
const available = new Set(blobNames.map(name => `sha256:${name}`));
if (!available.has(rootDigest)) throw new Error("OCI layout does not contain the requested root digest");

let layoutIndex;
try {
  layoutIndex = JSON.parse(await readFile(`${layout}/index.json`, "utf8"));
} catch {
  throw new Error("OCI layout index.json is not valid JSON");
}
if (!layoutIndex || !Array.isArray(layoutIndex.manifests) || layoutIndex.manifests.length !== 1) {
  throw new Error("OCI layout index.json must contain exactly one root manifest descriptor");
}
if (layoutIndex.schemaVersion !== 2) throw new Error("OCI layout index.json must use schemaVersion 2");
await validateDescriptor(layoutIndex.manifests[0], "OCI layout root", manifestGraphMediaTypes);
if (layoutIndex.manifests[0].digest !== rootDigest) {
  throw new Error("OCI layout root descriptor does not match the requested root digest");
}

const manifestOrder = [];
const manifests = new Set();
const visiting = new Set();
const reachable = new Set();
const verified = new Set();
async function visitManifest(digest, descriptorMediaType) {
  if (manifests.has(digest)) return;
  if (visiting.has(digest)) throw new Error(`OCI manifest graph contains a cycle at ${digest}`);
  visiting.add(digest);
  reachable.add(digest);
  await verifyBlobDigest(digest);
  const body = await readFile(`${blobDirectory}/${digest.slice("sha256:".length)}`);
  let manifest;
  try {
    manifest = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`Manifest ${digest} is not valid JSON`);
  }
  if (manifest.schemaVersion !== 2) throw new Error(`Manifest ${digest} must use schemaVersion 2`);
  if (manifest.mediaType !== descriptorMediaType) {
    throw new Error(`Descriptor mediaType does not match manifest ${digest}`);
  }
  const isIndex = Array.isArray(manifest.manifests);
  const isImageManifest = manifest.config != null && Array.isArray(manifest.layers);
  if (isIndex === isImageManifest) {
    throw new Error(`Manifest ${digest} has an invalid or ambiguous OCI structure`);
  }
  if (isIndex) {
    if (!indexMediaTypes.has(descriptorMediaType)) {
      throw new Error(`Descriptor mediaType does not describe index ${digest}`);
    }
    for (const descriptor of manifest.manifests) {
      await validateDescriptor(descriptor, `Index ${digest}`, manifestGraphMediaTypes);
      await visitManifest(descriptor.digest, descriptor.mediaType);
    }
  } else {
    if (!imageManifestMediaTypes.has(descriptorMediaType)) {
      throw new Error(`Descriptor mediaType does not describe image manifest ${digest}`);
    }
    await validateDescriptor(manifest.config, `Manifest ${digest} config`, configMediaTypes);
    reachable.add(manifest.config.digest);
    for (const descriptor of manifest.layers) {
      await validateDescriptor(descriptor, `Manifest ${digest} layer`, layerMediaTypes);
      reachable.add(descriptor.digest);
    }
    if (manifest.subject != null) {
      await validateDescriptor(manifest.subject, `Manifest ${digest} subject`, manifestGraphMediaTypes);
      await visitManifest(manifest.subject.digest, manifest.subject.mediaType);
    }
  }
  visiting.delete(digest);
  manifests.add(digest);
  manifestOrder.push(digest);
}
await visitManifest(rootDigest, layoutIndex.manifests[0].mediaType);

for (const digest of [...reachable].sort()) {
  await verifyBlobDigest(digest);
  if (manifests.has(digest)) continue;
  runOras([
    "blob", "push", ...remoteFlags(), "--no-tty",
    `${image}@${digest}`, `/release/blobs/sha256/${digest.slice("sha256:".length)}`,
  ]);
}
for (const digest of manifestOrder) {
  runOras([
    "manifest", "push", ...remoteFlags(),
    `${image}@${digest}`, `/release/blobs/sha256/${digest.slice("sha256:".length)}`,
  ]);
}
runOras(["manifest", "fetch", ...remoteFlags(), "--output", "/dev/null", `${image}@${rootDigest}`]);
process.stdout.write(`Published ${image}@${rootDigest} without creating a tag\n`);

async function verifyBlobDigest(digest) {
  if (verified.has(digest)) return;
  const path = `${blobDirectory}/${digest.slice("sha256:".length)}`;
  const actual = await sha256(path);
  if (actual !== digest) throw new Error(`OCI blob digest mismatch: expected ${digest}, got ${actual}`);
  verified.add(digest);
}

async function validateDescriptor(descriptor, context, supportedMediaTypes) {
  if (!descriptor || !/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest ?? "")) {
    throw new Error(`${context} contains an invalid descriptor`);
  }
  if (typeof descriptor.mediaType !== "string" || !supportedMediaTypes.has(descriptor.mediaType)) {
    throw new Error(`${context} contains an unsupported descriptor mediaType`);
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
    throw new Error(`${context} contains an invalid descriptor size`);
  }
  if (!available.has(descriptor.digest)) {
    throw new Error(`${context} references an absent blob: ${descriptor.digest}`);
  }
  const blob = await stat(`${blobDirectory}/${descriptor.digest.slice("sha256:".length)}`);
  if (!blob.isFile() || blob.size !== descriptor.size) {
    throw new Error(`${context} descriptor size does not match ${descriptor.digest}`);
  }
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolveHash(`sha256:${hash.digest("hex")}`));
  });
}

function remoteFlags() {
  const flags = [];
  if (plainHttp) flags.push("--plain-http");
  if (registryConfig) flags.push("--registry-config", "/auth/config.json");
  return flags;
}

function runOras(command) {
  const dockerArgs = [
    "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
    "--volume", `${layout}:/release:ro`,
  ];
  if (registryConfig) dockerArgs.push("--volume", `${registryConfig}:/auth/config.json:ro`);
  dockerArgs.push(orasImage, ...command);
  const result = spawnSync("docker", dockerArgs, { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ORAS command failed with status ${result.status}`);
}
