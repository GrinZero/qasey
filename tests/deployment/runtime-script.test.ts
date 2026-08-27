import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "../..");
const runtimeScript = resolve(projectRoot, "ci/runtime.sh");
const sandboxRuntimeScript = resolve(projectRoot, "ci/sandbox-runtime.sh");
const roleVariables = [
  "DATABASE_URL",
  "MASTRA_STEP_EXECUTION_URL",
  "MASTRA_WORKERS",
  "MASTRA_WORKER_AUTH_TOKEN",
  "QASEY_DEPLOYMENT_MODE",
  "QASEY_WORKER_METRICS_TOKEN",
  "WORKER_TOKEN",
] as const;

let fakeBin: string;

beforeAll(async () => {
  fakeBin = await mkdtemp(join(tmpdir(), "qasey-runtime-bin-"));
  const realNode = process.execPath.replace(/["\\$`]/gu, match => `\\${match}`);
  await Promise.all([
    writeFile(join(fakeBin, "node"), `#!/bin/sh
if [ "\${1:-}" = "-e" ]; then
  exec "${realNode}" "$@"
fi
printf 'FINAL_NODE=%s\\n' "$*"
printf 'MASTRA_WORKERS=%s\\n' "\${MASTRA_WORKERS:-}"
printf 'MASTRA_WORKER_AUTH_TOKEN=%s\\n' "\${MASTRA_WORKER_AUTH_TOKEN:-}"
printf 'MASTRA_STEP_EXECUTION_URL=%s\\n' "\${MASTRA_STEP_EXECUTION_URL:-}"
`, { mode: 0o755 }),
    writeFile(join(fakeBin, "sh"), `#!/bin/sh
printf 'MIGRATION_MASTRA_WORKERS=%s\\n' "\${MASTRA_WORKERS:-}"
`, { mode: 0o755 }),
  ]);
});

afterAll(async () => {
  await rm(fakeBin, { recursive: true, force: true });
});

describe("container runtime role contract", () => {
  it("forces the distributed API role without racing the pre-deploy migration job", async () => {
    const result = await runRuntime("api", {
      NODE_ENV: "production",
      QASEY_DEPLOYMENT_MODE: "distributed",
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).not.toContain("MIGRATION_MASTRA_WORKERS");
    expect(result.stdout).toContain("MASTRA_WORKERS=false");
    expect(result.stdout).toContain("FINAL_NODE=.mastra/output/index.mjs");
  });

  it("rejects a contradictory distributed API role before migration", async () => {
    const result = await runRuntime("api", {
      NODE_ENV: "production",
      QASEY_DEPLOYMENT_MODE: "distributed",
      MASTRA_WORKERS: "orchestration",
    });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("Distributed API requires MASTRA_WORKERS=false");
    expect(result.stdout).not.toContain("Applying Prisma database migrations");
    expect(result.stdout).not.toContain("MIGRATION_MASTRA_WORKERS");
  });

  it("forces the orchestration Worker role, step URL, and bearer identity without running migrations", async () => {
    const result = await runRuntime("worker", {
      NODE_ENV: "production",
      QASEY_DEPLOYMENT_MODE: "distributed",
      QASEY_WORKER_METRICS_TOKEN: "synthetic-worker-metrics-token-000000000000",
      WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes",
      MASTRA_STEP_EXECUTION_URL: "https://qasey.example.com/api",
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).not.toContain("MIGRATION_MASTRA_WORKERS");
    expect(result.stdout).toContain("MASTRA_WORKERS=orchestration");
    expect(result.stdout).toContain("MASTRA_WORKER_AUTH_TOKEN=worker-secret-with-at-least-32-random-bytes");
    expect(result.stdout).toContain("FINAL_NODE=dist/worker-supervisor.mjs");
  });

  it("allows explicit local HTTP only outside production", async () => {
    const local = await runRuntime("worker", {
      NODE_ENV: "test",
      QASEY_DEPLOYMENT_MODE: "distributed",
      WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes",
      MASTRA_STEP_EXECUTION_URL: "http://127.0.0.1:4111/api",
    });
    expect(local).toMatchObject({ code: 0, stderr: "" });

    const remote = await runRuntime("worker", {
      NODE_ENV: "test",
      QASEY_DEPLOYMENT_MODE: "distributed",
      WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes",
      MASTRA_STEP_EXECUTION_URL: "http://api.example.com",
    });
    expect(remote.code).toBe(78);
    expect(remote.stderr).toContain("must use HTTPS");
  });

  it("runs one explicit migration role and requires its database target", async () => {
    const missing = await runRuntime("migrate", { NODE_ENV: "production" });
    expect(missing.code).toBe(78);
    expect(missing.stderr).toContain("DATABASE_URL is required for the migration role");

    const configured = await runRuntime("migrate", {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example.invalid/qasey",
    });
    expect(configured).toMatchObject({ code: 0, stderr: "" });
    expect(configured.stdout).toContain("Applying Prisma database migrations");
    expect(configured.stdout).toContain("MIGRATION_MASTRA_WORKERS=");
    expect(configured.stdout).not.toContain("FINAL_NODE=");
  });

  it("retains automatic migrations for the standalone community profile", async () => {
    const result = await runRuntime("api", {
      NODE_ENV: "production",
      QASEY_DEPLOYMENT_MODE: "standalone",
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Applying Prisma database migrations");
    expect(result.stdout).toContain("MIGRATION_MASTRA_WORKERS=");
  });

  it.each([
    [{ MASTRA_WORKERS: "false", WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes", MASTRA_STEP_EXECUTION_URL: "https://qasey.example.com" }, "MASTRA_WORKERS=orchestration"],
    [{ WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes" }, "MASTRA_STEP_EXECUTION_URL is required"],
    [{ WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes", MASTRA_STEP_EXECUTION_URL: "http://127.0.0.1:4111" }, "must use HTTPS"],
    [{ WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes", MASTRA_WORKER_AUTH_TOKEN: "other-secret-with-at-least-32-random-bytes", MASTRA_STEP_EXECUTION_URL: "https://qasey.example.com" }, "must match WORKER_TOKEN"],
    [{ WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes", MASTRA_STEP_EXECUTION_URL: "https://qasey.example.com" }, "QASEY_WORKER_METRICS_TOKEN is required"],
    [{ WORKER_TOKEN: "too-short", MASTRA_STEP_EXECUTION_URL: "https://qasey.example.com", QASEY_WORKER_METRICS_TOKEN: "synthetic-worker-metrics-token-000000000000" }, "WORKER_TOKEN must contain at least 32 UTF-8 bytes"],
  ])("rejects contradictory Worker configuration before production migration", async (env, message) => {
    const result = await runRuntime("worker", { NODE_ENV: "production", QASEY_DEPLOYMENT_MODE: "distributed", ...env });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("Applying Prisma database migrations");
    expect(result.stdout).not.toContain("MIGRATION_MASTRA_WORKERS");
  });

  it("rejects a Worker process outside distributed mode before any migration", async () => {
    const result = await runRuntime("worker", {
      NODE_ENV: "production",
      QASEY_DEPLOYMENT_MODE: "standalone",
      WORKER_TOKEN: "worker-secret-with-at-least-32-random-bytes",
      MASTRA_STEP_EXECUTION_URL: "https://qasey.example.com/api",
    });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("Worker requires QASEY_DEPLOYMENT_MODE=distributed");
    expect(result.stdout).not.toContain("Applying Prisma database migrations");
  });

  it("does not expose the sandbox role from the service entrypoint", async () => {
    const result = await runRuntime("sandbox", { NODE_ENV: "production" });
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("Unknown Qasey process: sandbox");
    expect(result.stdout).not.toContain("sandbox-runtime.mjs");
  });
});

describe("sandbox container entrypoint contract", () => {
  it("starts only the sandbox artifact with synthetic production configuration", async () => {
    const result = await runSandboxRuntime("sandbox", {
      NODE_ENV: "production",
      OPENAI_API_KEY: "synthetic-model-key",
      QASEY_SANDBOX_CONTROL_KEY: "synthetic-sandbox-control-key-000000000000",
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("FINAL_NODE=dist/sandbox-runtime.mjs");
  });

  it("rejects service roles before reading production secrets", async () => {
    for (const role of ["api", "worker", "migrate"]) {
      const result = await runSandboxRuntime(role, { NODE_ENV: "production" });
      expect(result.code).toBe(64);
      expect(result.stderr).toContain("only supports the sandbox process");
      expect(result.stderr).not.toContain("OPENAI_API_KEY");
    }
  });

  it("fails closed when required production sandbox secrets are absent", async () => {
    const missingModel = await runSandboxRuntime("sandbox", {
      NODE_ENV: "production",
      QASEY_SANDBOX_CONTROL_KEY: "synthetic-sandbox-control-key-000000000000",
    });
    expect(missingModel.code).toBe(78);
    expect(missingModel.stderr).toContain("requires OPENAI_API_KEY");

    const missingControlKey = await runSandboxRuntime("sandbox", {
      NODE_ENV: "production",
      OPENAI_API_KEY: "synthetic-model-key",
    });
    expect(missingControlKey.code).toBe(78);
    expect(missingControlKey.stderr).toContain("QASEY_SANDBOX_CONTROL_KEY is required");
  });
});

async function runRuntime(role: "api" | "worker" | "migrate" | "sandbox", overrides: NodeJS.ProcessEnv) {
  const env = { ...process.env };
  for (const variable of roleVariables) delete env[variable];
  Object.assign(env, overrides, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
  try {
    const result = await exec("/bin/sh", [runtimeScript, role], { cwd: projectRoot, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

async function runSandboxRuntime(role: string, overrides: NodeJS.ProcessEnv) {
  const env = { ...process.env };
  for (const variable of ["NODE_ENV", "OPENAI_API_KEY", "QASEY_SANDBOX_CONTROL_KEY"]) delete env[variable];
  Object.assign(env, overrides, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
  try {
    const result = await exec("/bin/sh", [sandboxRuntimeScript, role], { cwd: projectRoot, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}
