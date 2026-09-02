import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `mastra dev` changes the child process cwd to `src/mastra/public`, so
// process.cwd() is not a stable project-root locator. The source module and
// Mastra's bundled entrypoints are both two directory levels below the root.
const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(moduleDirectory, "../..");

/**
 * Mastra bundles this module into `.mastra/output` or `.mastra/worker`.
 * Resolve the bundled path first, then fall back to the source tree used by
 * `mastra dev`, so both modes discover the same checked-in Skills.
 */
export function firstExistingPath(paths: readonly string[]): string {
  return paths.find(path => existsSync(path)) ?? paths[0]!;
}

export const GLOBAL_SKILLS_PATH = firstExistingPath([
  fileURLToPath(new URL("./skills", import.meta.url)),
  resolve(projectRoot, "src/mastra/skills"),
]);

export const QASEY_MAIN_SKILLS_PATH = firstExistingPath([
  fileURLToPath(new URL("./agents/qasey-main/skills", import.meta.url)),
  resolve(projectRoot, "src/mastra/agents/qasey-main/skills"),
]);
