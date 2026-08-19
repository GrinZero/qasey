import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

const ADMIN_UI_HTML_RELATIVE_PATH = "apps/admin-ui/dist/index.html";
let cachedHtml: string | undefined;

export function resolveAdminUiHtmlPath(startingDirectory = process.cwd()): string {
  let directory = resolve(startingDirectory);
  const filesystemRoot = parse(directory).root;

  while (true) {
    const candidate = resolve(directory, ADMIN_UI_HTML_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
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
