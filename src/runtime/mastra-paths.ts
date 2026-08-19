export const MASTRA_STUDIO_BASE = "/studio";
export const MASTRA_API_PREFIX = `${MASTRA_STUDIO_BASE}/api`;

export function stripMastraApiPrefix(path: string): string | undefined {
  if (path === MASTRA_API_PREFIX) return "/";
  if (!path.startsWith(`${MASTRA_API_PREFIX}/`)) return undefined;
  return path.slice(MASTRA_API_PREFIX.length);
}
