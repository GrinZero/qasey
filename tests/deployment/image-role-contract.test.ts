import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "../..");

describe("container image role isolation", () => {
  it("ships no shell-controlled repository broker capability", async () => {
    const [wrapper, runtime, skill] = await Promise.all([
      readFile(resolve(projectRoot, "apps/cli/src/gh-wrapper.ts"), "utf8"),
      readFile(resolve(projectRoot, "src/sandbox/runtime.ts"), "utf8"),
      readFile(resolve(projectRoot, "src/mastra/skills/git-repository-workspace/SKILL.md"), "utf8"),
    ]);
    const brokerEnvironmentPrefix = ["QASEY", "GH", "BROKER"].join("_");

    expect(wrapper).not.toContain(brokerEnvironmentPrefix);
    expect(wrapper).not.toContain("fetch(");
    expect(runtime).not.toContain(brokerEnvironmentPrefix);
    expect(skill).toContain("generic session 没有平台注入的 GitHub 凭据、共享 mirror或 repository broker");
    expect(skill).toContain("tenant-bound平台工具或 Code Task workflow");
  });

  it("keeps the sandbox toolchain out of the default service stage", async () => {
    const dockerfile = await readFile(resolve(projectRoot, "Dockerfile"), "utf8");
    const sandboxMarker = dockerfile.indexOf(" AS sandbox-runtime");
    const serviceMarker = dockerfile.indexOf(" AS service-runtime");
    const sandboxStart = dockerfile.lastIndexOf("FROM ", sandboxMarker);
    const serviceStart = dockerfile.lastIndexOf("FROM ", serviceMarker);
    expect(sandboxStart).toBeGreaterThan(-1);
    expect(serviceStart).toBeGreaterThan(sandboxStart);
    const sandboxStage = dockerfile.slice(sandboxStart, serviceStart);
    const serviceStage = dockerfile.slice(serviceStart);

    expect(sandboxStage).toContain("apt-get install -y --no-install-recommends");
    for (const tool of ["bubblewrap", "build-essential", "git", "gh", "openssh-client", "python3", "xvfb"]) {
      expect(sandboxStage).toContain(tool);
    }
    expect(sandboxStage).toContain("tini");
    expect(sandboxStage).toContain('ENTRYPOINT ["tini", "--", "sh", "ci/sandbox-runtime.sh"]');
    expect(sandboxStage).toContain("corepack install --global pnpm@11.21.0");
    expect(sandboxStage).toContain('test "$(pnpm --version)" = "11.21.0"');
    expect(sandboxStage).toContain("COPY --from=sandbox-dependencies /sandbox/node_modules ./node_modules");
    expect(sandboxStage).not.toContain("COPY --from=build /app/node_modules ./node_modules");
    expect(sandboxStage).toContain("/app/dist/sandbox-runtime.mjs");
    expect(sandboxStage).not.toContain("/app/dist/worker-supervisor.mjs");
    expect(sandboxStage).not.toContain("/app/dist/mcp-login.mjs");
    expect(sandboxStage).not.toContain("/app/.mastra/output");
    expect(sandboxStage).not.toContain("/app/.mastra/worker");
    expect(sandboxStage).not.toContain("/app/prisma");
    expect(sandboxStage).not.toContain("/app/config");

    expect(serviceStage).toMatch(/^.*FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS service-runtime/mu);
    expect(serviceStage).toContain("apt-get install -y --no-install-recommends ca-certificates openssl");
    for (const tool of ["bubblewrap", "build-essential", "git", "gh", "openssh-client", "python3", "xvfb"]) {
      expect(serviceStage).not.toMatch(new RegExp(`apt-get install[^\\n]*${tool}`, "u"));
    }
    expect(serviceStage).toContain("COPY --from=service-dependencies /service/node_modules ./node_modules");
    expect(serviceStage).toContain("COPY --from=service-dependencies /service/package.json ./package.json");
    expect(serviceStage).not.toContain("COPY --from=build /app/package.json");
    expect(serviceStage).toContain("/app/dist/worker-supervisor.mjs");
    expect(serviceStage).toContain("ci/verify-baseline-adoption.mjs");
    expect(serviceStage).not.toContain("COPY --from=build /app/dist ./dist");
    expect(serviceStage).not.toContain("COPY --from=build /app/node_modules ./node_modules");
    expect(serviceStage).not.toContain("/app/dist/sandbox-runtime.mjs ./dist");
    expect(serviceStage).toContain('CMD ["sh", "ci/start.sh", "api"]');
  });

  it("derives a range-free service dependency closure from the committed lockfile", async () => {
    const output = await mkdtemp(join(tmpdir(), "qasey-service-manifest-"));
    try {
      const manifestPath = join(output, "package.json");
      const lockPath = join(output, "pnpm-lock.yaml");
      const workspacePath = join(output, "pnpm-workspace.yaml");
      await exec(process.execPath, [
        resolve(projectRoot, "ci/create-service-runtime-manifest.mjs"),
        resolve(projectRoot, "package.json"),
        resolve(projectRoot, "pnpm-lock.yaml"),
        manifestPath,
        lockPath,
        "--profile",
        "service",
        "--source-workspace",
        resolve(projectRoot, "pnpm-workspace.yaml"),
        "--destination-workspace",
        workspacePath,
      ], { cwd: projectRoot });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies: Record<string, string> };
      const lockfile = await readFile(lockPath, "utf8");
      const workspace = await readFile(workspacePath, "utf8");
      const importer = lockfile.slice(0, lockfile.indexOf("\npackages:\n"));

      expect(manifest.dependencies).toHaveProperty("prisma");
      expect(manifest.dependencies).not.toHaveProperty("@playwright/test");
      expect(manifest.dependencies).not.toHaveProperty("@trycua/cua-driver");
      expect(Object.values(manifest.dependencies).every(version =>
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version),
      )).toBe(true);
      expect(Object.values(manifest.dependencies).join("\n")).not.toMatch(/[~^*]|workspace:|link:|file:/u);
      expect(importer).not.toContain("@playwright/test");
      expect(importer).not.toContain("@trycua/cua-driver");
      expect(importer).toContain("overrides:\n");
      expect(importer).toContain("hono@4.10.6");
      expect(importer).toContain("4.13.1");
      expect(importer).toContain("patchedDependencies:\n  '@mastra/core@1.59.0'");
      expect(workspace).toContain("packages: []");
      expect(workspace).toContain("overrides:\n");
      expect(workspace).toContain("'hono@4.10.6': '4.13.1'");
      expect(workspace).toContain("patchedDependencies:\n  '@mastra/core@1.59.0'");
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("derives a six-package sandbox closure without service connectors", async () => {
    const output = await mkdtemp(join(tmpdir(), "qasey-sandbox-manifest-"));
    try {
      const manifestPath = join(output, "package.json");
      const lockPath = join(output, "pnpm-lock.yaml");
      const workspacePath = join(output, "pnpm-workspace.yaml");
      await exec(process.execPath, [
        resolve(projectRoot, "ci/create-service-runtime-manifest.mjs"),
        resolve(projectRoot, "package.json"),
        resolve(projectRoot, "pnpm-lock.yaml"),
        manifestPath,
        lockPath,
        "--profile",
        "sandbox",
        "--source-workspace",
        resolve(projectRoot, "pnpm-workspace.yaml"),
        "--destination-workspace",
        workspacePath,
      ], { cwd: projectRoot });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies: Record<string, string> };
      expect(Object.keys(manifest.dependencies).sort()).toEqual([
        "@ai-sdk/openai",
        "@mastra/core",
        "@playwright/test",
        "@trycua/cua-driver",
        "jose",
        "zod",
      ]);
      expect(Object.values(manifest.dependencies).every(version => /^\d+\.\d+\.\d+/u.test(version))).toBe(true);
      for (const connector of ["@aws-sdk/client-s3", "@octokit/rest", "@prisma/client", "@slack/web-api", "dd-trace", "ioredis", "pg", "prisma"]) {
        expect(manifest.dependencies).not.toHaveProperty(connector);
      }
      expect(await readFile(lockPath, "utf8")).toContain("overrides:\n");
      expect(await readFile(workspacePath, "utf8")).toContain("overrides:\n");
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("pins every external CI service and Docker base image by digest", async () => {
    const [workflow, dockerfile] = await Promise.all([
      readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(projectRoot, "Dockerfile"), "utf8"),
    ]);
    const services = [...workflow.matchAll(/^\s*image:\s*(\S+)$/gmu)].map(([, image]) => image);
    expect(services.length).toBeGreaterThan(0);
    expect(services.every(image => /@sha256:[a-f0-9]{64}$/u.test(image ?? ""))).toBe(true);
    expect(workflow).toContain("name: Smoke digest-addressed OCI layout reader");
    expect(workflow).toContain('--output "type=oci,dest=${archive}"');
    expect(workflow).toContain('sh ci/extract-oci-layout.sh "$archive" "$layout"');
    expect(workflow).toContain('manifest fetch --oci-layout --output /dev/null "/release@${digest}"');
    expect(workflow).toContain("cp --from-oci-layout --to-oci-layout --no-tty");
    expect(workflow).toContain("registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373");
    expect(workflow).toContain("node ci/publish-oci-layout-by-digest.mjs");
    expect(workflow).toContain("qasey-layout-smoke/tags/list");
    expect(workflow).toContain("test \"$tags_status\" = 404");

    const externalBases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gmu)]
      .map(([, image]) => image ?? "")
      .filter(image => image.includes(":") || image.includes("/"));
    expect(externalBases.length).toBeGreaterThan(0);
    expect(externalBases.every(image => /@sha256:[a-f0-9]{64}$/u.test(image))).toBe(true);
  });

  it("extracts generated OCI archives but rejects every non-regular entry", async () => {
    const output = await mkdtemp(join(tmpdir(), "qasey-oci-extract-"));
    const source = join(output, "source");
    const archive = join(output, "valid.oci.tar");
    const destination = join(output, "layout");
    const maliciousSource = join(output, "malicious");
    const maliciousArchive = join(output, "malicious.oci.tar");
    const fifoSource = join(output, "fifo");
    const fifoArchive = join(output, "fifo.oci.tar");
    const script = resolve(projectRoot, "ci/extract-oci-layout.sh");
    try {
      await mkdir(join(source, "blobs", "sha256"), { recursive: true });
      await Promise.all([
        writeFile(join(source, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n'),
        writeFile(join(source, "index.json"), '{"schemaVersion":2,"manifests":[]}\n'),
      ]);
      await exec("tar", ["-cf", archive, "-C", source, "."]);
      await exec("sh", [script, archive, destination]);
      expect(await readFile(join(destination, "oci-layout"), "utf8")).toContain("1.0.0");

      await mkdir(maliciousSource);
      await symlink("/tmp", join(maliciousSource, "escape"));
      await exec("tar", ["-cf", maliciousArchive, "-C", maliciousSource, "."]);
      await expect(exec("sh", [script, maliciousArchive, join(output, "rejected")]))
        .rejects.toThrow(/OCI archive contains a non-regular, non-directory entry/u);

      await mkdir(fifoSource);
      await exec("mkfifo", [join(fifoSource, "payload")]);
      await exec("tar", ["-cf", fifoArchive, "-C", fifoSource, "."]);
      await expect(exec("sh", [script, fifoArchive, join(output, "fifo-rejected")]))
        .rejects.toThrow(/OCI archive contains a non-regular, non-directory entry/u);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("publishes only blobs reachable from the layout's unique requested root", async () => {
    const output = await mkdtemp(join(tmpdir(), "qasey-oci-publish-"));
    const layout = join(output, "layout");
    const fakeBin = join(output, "bin");
    const dockerLog = join(output, "docker.log");
    const script = resolve(projectRoot, "ci/publish-oci-layout-by-digest.mjs");
    try {
      await Promise.all([
        mkdir(join(layout, "blobs", "sha256"), { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
      ]);
      await writeFile(join(layout, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n');
      const config = await writeOciBlob(layout, '{"architecture":"amd64","os":"linux"}\n');
      const layer = await writeOciBlob(layout, "reachable layer\n");
      const orphan = await writeOciBlob(layout, "unreachable evidence\n");
      const manifestBody = `${JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: config.digest,
          size: config.size,
        },
        layers: [{
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          digest: layer.digest,
          size: layer.size,
        }],
      })}\n`;
      const manifest = await writeOciBlob(layout, manifestBody);
      const rootDescriptor = {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifest.digest,
        size: manifest.size,
      };
      await writeFile(join(layout, "index.json"), `${JSON.stringify({ schemaVersion: 2, manifests: [rootDescriptor] })}\n`);
      await writeFile(join(fakeBin, "docker"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$QASEY_DOCKER_LOG"\n', { mode: 0o755 });

      await exec(process.execPath, [script, layout, "registry.example.invalid/qasey", manifest.digest, "--plain-http"], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          QASEY_DOCKER_LOG: dockerLog,
        },
      });
      const invocations = await readFile(dockerLog, "utf8");
      for (const reachable of [config.digest, layer.digest, manifest.digest]) {
        expect(invocations).toContain(reachable.slice("sha256:".length));
      }
      expect(invocations).not.toContain(orphan.digest.slice("sha256:".length));

      await writeFile(join(layout, "index.json"), `${JSON.stringify({ schemaVersion: 1, manifests: [rootDescriptor] })}\n`);
      await expect(exec(process.execPath, [script, layout, "registry.example.invalid/qasey", manifest.digest, "--plain-http"], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, QASEY_DOCKER_LOG: dockerLog },
      })).rejects.toThrow(/index\.json must use schemaVersion 2/u);

      const rootWithoutSize: Partial<typeof rootDescriptor> = { ...rootDescriptor };
      delete rootWithoutSize.size;
      await writeFile(join(layout, "index.json"), `${JSON.stringify({ schemaVersion: 2, manifests: [rootWithoutSize] })}\n`);
      await expect(exec(process.execPath, [script, layout, "registry.example.invalid/qasey", manifest.digest, "--plain-http"], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, QASEY_DOCKER_LOG: dockerLog },
      })).rejects.toThrow(/OCI layout root contains an invalid descriptor size/u);

      await writeFile(join(layout, "index.json"), `${JSON.stringify({
        schemaVersion: 2,
        manifests: [{ ...rootDescriptor, mediaType: "application/vnd.oci.image.index.v1+json" }],
      })}\n`);
      await expect(exec(process.execPath, [script, layout, "registry.example.invalid/qasey", manifest.digest, "--plain-http"], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, QASEY_DOCKER_LOG: dockerLog },
      })).rejects.toThrow(/Descriptor mediaType does not match manifest/u);

      const invalidConfigManifest = await writeOciBlob(layout, `${JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { digest: config.digest, size: config.size },
        layers: [],
      })}\n`);
      const invalidConfigRoot = {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: invalidConfigManifest.digest,
        size: invalidConfigManifest.size,
      };
      await writeFile(join(layout, "index.json"), `${JSON.stringify({ schemaVersion: 2, manifests: [invalidConfigRoot] })}\n`);
      await expect(exec(process.execPath, [script, layout, "registry.example.invalid/qasey", invalidConfigManifest.digest, "--plain-http"], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, QASEY_DOCKER_LOG: dockerLog },
      })).rejects.toThrow(/config contains an unsupported descriptor mediaType/u);

      await writeFile(join(layout, "index.json"), `${JSON.stringify({
        schemaVersion: 2,
        manifests: [rootDescriptor, rootDescriptor],
      })}\n`);
      await expect(exec(process.execPath, [script, layout, "registry.example.invalid/qasey", manifest.digest, "--plain-http"], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, QASEY_DOCKER_LOG: dockerLog },
      })).rejects.toThrow(/index\.json must contain exactly one root manifest descriptor/u);

      await writeFile(join(layout, "index.json"), `${JSON.stringify({
        schemaVersion: 2,
        manifests: [{ ...rootDescriptor, digest: orphan.digest, size: orphan.size }],
      })}\n`);
      await expect(exec(process.execPath, [script, layout, "registry.example.invalid/qasey", manifest.digest, "--plain-http"], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, QASEY_DOCKER_LOG: dockerLog },
      })).rejects.toThrow(/root descriptor does not match the requested root digest/u);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});

async function writeOciBlob(layout: string, contents: string) {
  const data = Buffer.from(contents);
  const hex = createHash("sha256").update(data).digest("hex");
  await writeFile(join(layout, "blobs", "sha256", hex), data);
  return { digest: `sha256:${hex}`, size: data.byteLength };
}
