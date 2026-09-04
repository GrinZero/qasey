import { extname } from "node:path";

export const PLAYWRIGHT_TRACE_VIEWER_ROUTE_PREFIX = "/v1/case-hub/trace-viewer/";

export function traceViewerRelativePath(requestUrl: string): string | undefined {
  const pathname = new URL(requestUrl).pathname;
  if (!pathname.startsWith(PLAYWRIGHT_TRACE_VIEWER_ROUTE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(pathname.slice(PLAYWRIGHT_TRACE_VIEWER_ROUTE_PREFIX.length)) || "index.html";
  } catch {
    return undefined;
  }
}

export function traceViewerContentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".webmanifest") return "application/manifest+json";
  if (extension === ".ttf") return "font/ttf";
  return "application/octet-stream";
}
