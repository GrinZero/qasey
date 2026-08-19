import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

const ADMIN_UI_HTML_RELATIVE_PATH = "apps/admin-ui/dist/index.html";
const ADMIN_UI_WORKSPACE_RELATIVE_PATH = "apps/admin-ui";
let cachedHtml: string | undefined;

export function resolveAdminUiHtmlPath(startingDirectory = process.cwd()): string {
  let directory = resolve(startingDirectory);
  const filesystemRoot = parse(directory).root;

  while (true) {
    const candidate = resolve(directory, ADMIN_UI_HTML_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    // The build artifact is intentionally ignored by Git. During a clean CI
    // checkout, still resolve it relative to the repository root so callers
    // do not accidentally append the path below Mastra's changed cwd.
    if (existsSync(resolve(directory, ADMIN_UI_WORKSPACE_RELATIVE_PATH))) return candidate;
    if (directory === filesystemRoot) return resolve(startingDirectory, ADMIN_UI_HTML_RELATIVE_PATH);
    directory = dirname(directory);
  }
}

/** Loads the single-file Vite build. Production images copy this artifact. */
export async function loadAdminUiHtml(): Promise<string> {
  const adminUiHtmlPath = resolveAdminUiHtmlPath();
  cachedHtml ??= await readFile(adminUiHtmlPath, "utf8").catch(error => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Admin UI is not built. Run \"pnpm admin-ui:build\" before starting the runtime. ${reason}`);
  });
  return cachedHtml;
}
