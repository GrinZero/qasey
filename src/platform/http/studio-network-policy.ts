import type { Middleware } from "@mastra/core/server";
import { MASTRA_API_PREFIX, MASTRA_STUDIO_BASE } from "../../runtime/mastra-paths.ts";

export const STUDIO_CONNECT_SRC_POLICY = "connect-src 'self'";
type MiddlewareFunction = Extract<Middleware, (...args: never[]) => unknown>;

export function isStudioDocumentPath(path: string, method: string): boolean {
  return method === "GET"
    && (path === MASTRA_STUDIO_BASE || path.startsWith(`${MASTRA_STUDIO_BASE}/`))
    && path !== MASTRA_API_PREFIX
    && !path.startsWith(`${MASTRA_API_PREFIX}/`);
}

/**
 * Mastra Studio checks every installed package against registry.npmjs.org from
 * the browser, even on pages that do not display package updates. Besides
 * leaking the dependency inventory, that adds several megabytes of unrelated
 * network traffic to cold navigation. Studio only needs the same-origin
 * runtime API, so keep browser connections on the runtime origin.
 */
export const applyStudioNetworkPolicy: MiddlewareFunction = async (context, next) => {
  await next();
  if (isStudioDocumentPath(context.req.path, context.req.method)) {
    context.header("Content-Security-Policy", STUDIO_CONNECT_SRC_POLICY);
  }
};
