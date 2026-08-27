import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("community deployment", () => {
  it("publishes the project under Apache License 2.0", async () => {
    const [license, manifest, readme, migration] = await Promise.all([
      readFile(resolve(projectRoot, "LICENSE"), "utf8"),
      readFile(resolve(projectRoot, "package.json"), "utf8"),
      readFile(resolve(projectRoot, "README.md"), "utf8"),
      readFile(resolve(projectRoot, "docs/open-source-migration.md"), "utf8"),
    ]);
    expect(license).toContain("Apache License\n                           Version 2.0, January 2004");
    expect(license).toContain("END OF TERMS AND CONDITIONS");
    expect(JSON.parse(manifest)).toMatchObject({ license: "Apache-2.0" });
    expect(readme).toContain("[Apache License 2.0](./LICENSE)");
    expect(migration).toContain("rights holder approved Apache License 2.0");
  });

  it("provides a safe standalone cloud blueprint", async () => {
    const blueprint = await readFile(resolve(projectRoot, "render.yaml"), "utf8");
    expect(blueprint).toContain("QASEY_DEPLOYMENT_MODE\n        value: standalone");
    expect(blueprint).toContain("DATABASE_URL\n        sync: false");
    expect(blueprint).not.toContain("GOOGLE_COOKIE_PASSWORD");
    expect(blueprint).not.toContain("QASEY_ENABLE_STUDIO_EDITOR");
    expect(blueprint).not.toMatch(/REDIS_|WORKER_TOKEN|SANDBOX_ENDPOINT/u);
  });

  it("provides reproducible local infrastructure and redacted configuration", async () => {
    const [compose, example, bootstrap, configuration] = await Promise.all([
      readFile(resolve(projectRoot, "docker-compose.yml"), "utf8"),
      readFile(resolve(projectRoot, ".env.example"), "utf8"),
      readFile(resolve(projectRoot, "scripts/bootstrap.sh"), "utf8"),
      readFile(resolve(projectRoot, "docs/configuration.md"), "utf8"),
    ]);
    expect(compose).toContain("postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73");
    expect(compose).toContain("redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf");
    expect(compose).toContain("${QASEY_POSTGRES_PORT:-5432}:5432");
    expect(compose).toContain("${QASEY_REDIS_PORT:-6379}:6379");
    expect(example).toContain("DATABASE_URL=postgresql://postgres:postgres@localhost:5432/qasey");
    expect(example).toContain("QASEY_INSTANCE_ID=");
    expect(example).toContain("QASEY_DEPLOYMENT_ID=");
    expect(bootstrap).toContain("docker compose up -d --wait postgres redis");
    expect(bootstrap).toContain("pnpm db:migrate:deploy");
    expect(configuration).toContain(".env.<NODE_ENV>.local");
    expect(configuration).toContain("QASEY_INSTANCE_ID");
    expect(configuration).toContain("QASEY_DEPLOYMENT_ID");
    expect(configuration).not.toContain("NAMESPACE");
    expect(configuration).not.toContain("CODEX_API_KEY");
  });

  it("maps the documented worker identity to Mastra's remote-worker token", async () => {
    const runtime = await readFile(resolve(projectRoot, "ci/runtime.sh"), "utf8");
    expect(runtime).toContain('configuration_error "WORKER_TOKEN is required for the orchestration worker"');
    expect(runtime).toContain('MASTRA_WORKER_AUTH_TOKEN="${MASTRA_WORKER_AUTH_TOKEN:-$WORKER_TOKEN}"');
    expect(runtime).toContain("MASTRA_WORKER_AUTH_TOKEN must match WORKER_TOKEN");
  });

  it("sets deterministic distributed roles and reserves migrations for one pre-deploy job", async () => {
    const runtime = await readFile(resolve(projectRoot, "ci/runtime.sh"), "utf8");
    expect(runtime).toContain("MASTRA_WORKERS=false");
    expect(runtime).toContain("MASTRA_WORKERS=orchestration");
    expect(runtime).toContain("MASTRA_STEP_EXECUTION_URL is required for the orchestration worker");
    expect(runtime).toContain('if [ "${QASEY_DEPLOYMENT_MODE:-standalone}" = "distributed" ]');
    expect(runtime).toContain("run_predeploy_migration");
    expect(runtime).toContain("migrate)");
    expect(runtime).toContain('configuration_error "DATABASE_URL is required for the migration role"');
  });

  it("keeps the sandbox portable instead of retaining the private runner infrastructure", async () => {
    const [runtime, workspace, compositionRoot] = await Promise.all([
      readFile(resolve(projectRoot, "src/sandbox/runtime.ts"), "utf8"),
      readFile(resolve(projectRoot, "src/platform/workspace/sandbox-client.ts"), "utf8"),
      readFile(resolve(projectRoot, "src/mastra/index.ts"), "utf8"),
    ]);
    await expect(access(resolve(projectRoot, "packages/e2e/src/job-manifest.ts"))).rejects.toThrow();
    expect(runtime).not.toMatch(/\b(?:Kubernetes|Pod|NAMESPACE)\b/u);
    expect(workspace).toContain("isolated remote sandbox runtime");
    expect(workspace).not.toContain("Kubernetes");
    expect(compositionRoot).toContain("config.QASEY_DEPLOYMENT_ID ?? config.NODE_ENV");
    expect(compositionRoot).not.toContain("process.env.NAMESPACE");
  });

  it("builds and probes isolated service and sandbox images in public CI", async () => {
    const [workflow, dockerfile, dockerignore] = await Promise.all([
      readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(projectRoot, "Dockerfile"), "utf8"),
      readFile(resolve(projectRoot, ".dockerignore"), "utf8"),
    ]);
    expect(workflow).toContain("service-image-smoke:");
    expect(workflow).toContain("sandbox-image-smoke:");
    expect(workflow).toContain("docker build --target service-runtime --tag qasey-service:ci .");
    expect(workflow).toContain("docker build --target sandbox-runtime --tag qasey-sandbox:ci .");
    expect(workflow).toContain("Validate Kubernetes 1.36 manifests against pinned schemas");
    expect(workflow).toContain("ghcr.io/yannh/kubeconform:v0.8.0-alpine@sha256:6b90a5f23d846140ce0194fe050b1995e546eba938f3a6bf10c039dd5e24588f");
    expect(workflow).toContain("-strict -summary -kubernetes-version 1.36.0");
    expect(workflow).toContain("yannh/kubernetes-json-schema/5a69f8365c9d3ed7de997f5365e22481cf775fa2");
    expect(workflow).toContain("http://127.0.0.1:8080/healthz");
    expect(workflow).toContain("http://127.0.0.1:8080/readyz");
    expect(workflow).toContain("http://127.0.0.1:4120/healthz");
    expect(workflow).toContain("http://127.0.0.1:4120/readyz");
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
    const serviceJob = workflow.slice(workflow.indexOf("\n  service-image-smoke:"), workflow.indexOf("\n  sandbox-image-smoke:"));
    const sandboxJob = workflow.slice(workflow.indexOf("\n  sandbox-image-smoke:"));
    expect(serviceJob).not.toContain("--security-opt seccomp=unconfined");
    expect(serviceJob).not.toContain("--security-opt systempaths=unconfined");
    expect(serviceJob).not.toContain("--security-opt apparmor=unconfined");
    expect(sandboxJob).toContain("--security-opt seccomp=unconfined");
    expect(sandboxJob).toContain("--security-opt systempaths=unconfined");
    expect(sandboxJob).toContain("--security-opt apparmor=unconfined");
    expect(sandboxJob).toContain("printf host-device > /dev/qasey-host-device-sentinel");
    expect(sandboxJob).toContain('test "$(cat /dev/qasey-host-device-sentinel)" = host-device');
    expect(sandboxJob).toContain("packageManager");
    expect(sandboxJob).toContain("pnpm install --lockfile-only --ignore-scripts");
    expect(sandboxJob).toContain("git add isolation.spec.js package.json pnpm-lock.yaml");
    expect(sandboxJob).toContain("ps -eo stat=,ppid=,pid=,comm=");
    expect(sandboxJob).toContain("live sandbox descendants remain after stop");
    expect(sandboxJob).toContain('QASEY_IMAGE_DIGEST=${image_digest}');
    expect(workflow).toContain('ln -s /tmp/qasey-host-sentinel "$browser/latest.jpg"');
    expect(workflow).toContain('test "$(cat /tmp/qasey-host-sentinel)" = host-secret');
    expect(workflow).toContain('test ! -L "$latest"');
    expect(workflow.match(/actions\/checkout@/gu)?.length).toBeGreaterThan(0);
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(
      workflow.match(/actions\/checkout@/gu)?.length ?? 0,
    );
    expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS dependencies$/mu);
    expect(dockerfile).toMatch(/^FROM mcr\.microsoft\.com\/playwright:v1\.62\.1-noble@sha256:[a-f0-9]{64} AS sandbox-runtime$/mu);
    expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS service-runtime$/mu);
    expect(dockerfile.lastIndexOf(" AS service-runtime")).toBeGreaterThan(dockerfile.lastIndexOf(" AS sandbox-runtime"));
    expect(dockerfile).toContain("/app/src/load-env.ts ./src/load-env.ts");
    expect(dockerignore).toContain(".env\n.env.*\n!.env.example\n!.env.*.example");
    expect(dockerignore).toContain("*.pem");
    expect(dockerignore).toContain("config/mcp.json");
    expect(dockerignore).toContain("config/e2e-repository.json");
  });
});
