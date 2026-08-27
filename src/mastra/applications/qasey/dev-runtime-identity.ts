import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DevRuntimeIdSchema } from "./dev-runtime-protocol.ts";

const DEFAULT_RUNTIME_ID_PATH = resolve(findRepositoryRoot(), ".qasey/dev-runtime-id");

function findRepositoryRoot(): string {
  const candidates = [
    process.env.INIT_CWD,
    process.env.QASEY_DATA_ROOT,
    process.env.MASTRA_PROJECT_ROOT,
    process.cwd(),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    let current = resolve(candidate);
    for (;;) {
      try {
        const packageJson = JSON.parse(readFileSync(resolve(current, "package.json"), "utf8")) as { name?: unknown };
        if (packageJson.name === "qasey") return current;
      } catch {
        // Keep walking until the repository package manifest is found.
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return resolve(process.env.INIT_CWD ?? process.cwd());
}

/**
 * Mastra dev replaces the server process during a hot reload. Keep the
 * runtime identity outside the generated `.mastra` directory so an existing
 * Slack binding can be reused by the replacement process.
 */
export function resolveDevRuntimeId(
  configuredId?: string,
  runtimeIdPath = DEFAULT_RUNTIME_ID_PATH,
): string {
  if (configuredId) return DevRuntimeIdSchema.parse(configuredId);

  try {
    const persistedId = DevRuntimeIdSchema.safeParse(readFileSync(runtimeIdPath, "utf8").trim());
    if (persistedId.success) return persistedId.data;
  } catch {
    // The first local start has no identity file yet.
  }

  const generatedId = generateRuntimeId();
  mkdirSync(dirname(runtimeIdPath), { recursive: true });
  writeFileSync(runtimeIdPath, `${generatedId}\n`, "utf8");
  return generatedId;
}

function generateRuntimeId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `local-${Array.from(randomBytes(8), byte => alphabet[byte % alphabet.length]).join("")}`;
}
