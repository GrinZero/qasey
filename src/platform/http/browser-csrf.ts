import type { Middleware } from "@mastra/core/server";

type MiddlewareFunction = Extract<Middleware, (...args: never[]) => unknown>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface BrowserCsrfOptions {
  publicBaseUrl: string;
}

/**
 * Enforces an exact same-origin boundary for every authenticated browser
 * mutation. Authorization runs first and hydrates either `user` for an OIDC
 * cookie session or an `admin-ui` principal for browser-only platform APIs.
 * Bearer-token and signed service traffic retain their non-browser contract.
 */
export function createBrowserCsrfMiddleware(options: BrowserCsrfOptions): MiddlewareFunction {
  const expectedOrigin = new URL(options.publicBaseUrl).origin;
  return async (context, next) => {
    if (SAFE_METHODS.has(context.req.method.toUpperCase())) return next();

    const requestContext = context.get("requestContext") as {
      get(key: string): unknown;
    } | undefined;
    const principal = requestContext?.get("platform-principal");
    const browserAuthenticated = requestContext?.get("user") !== undefined
      || (isRecord(principal) && principal.audience === "admin-ui");
    if (!browserAuthenticated) return next();

    const suppliedOrigin = context.req.header("origin");
    if (suppliedOrigin === expectedOrigin) return next();

    context.header("cache-control", "no-store");
    context.header("vary", "Origin");
    const requestId = requestContext?.get("requestId");
    return context.json({
      error: "csrf_rejected",
      ...(typeof requestId === "string" ? { requestId } : {}),
    }, 403);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
