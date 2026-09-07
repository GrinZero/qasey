import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export function isDevelopmentContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

type RunDocker = (args: string[]) => number;

function runDocker(args: string[]): number {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) {
    throw new Error("Cannot run Docker. Install and start Docker Desktop, then retry pnpm dev:container.", { cause: result.error });
  }
  return result.status ?? (result.signal === "SIGINT" ? 130 : 143);
}

export function startContainerDevelopment(
  run: RunDocker = runDocker,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): number {
  const compose = ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml"];
  // Let Compose resolve its own environment before Qasey's host env loader runs.
  // Both services then receive the same control key, including custom overrides.
  // depends_on already waits for health checks and the one-shot migration.
  const status = run([...compose, "up", "--build", "-d", "development"]);
  if (status !== 0) return status;
  return run([
    ...compose, "exec", ...(interactive ? [] : ["-T"]),
    "--user", "node", "development", "pnpm", "dev:container",
  ]);
}

export function validateContainerSandboxEnvironment(env: NodeJS.ProcessEnv): void {
  const missing = ["QASEY_SANDBOX_CONTROL_KEY", "QASEY_SANDBOX_LEASE_KEY"]
    .filter(key => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Development container is missing ${missing.join(", ")}. ` +
      "Run pnpm dev:container from the host to recreate the Compose services, " +
      "or use Dev Containers: Rebuild Container. Compose supplies matching Sandbox keys automatically.",
    );
  }
}
