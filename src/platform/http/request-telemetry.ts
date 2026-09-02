import type { Middleware } from "@mastra/core/server";

type MiddlewareFunction = Extract<Middleware, (...args: never[]) => unknown>;

export interface HttpRequestObservation {
  applicationId: string;
  routeId: string;
  method: string;
  status: number;
  durationMs: number;
}

export function createRequestTelemetryMiddleware(options: {
  observe(input: HttpRequestObservation): void;
  now?: () => number;
  onObservationError?: (error: Error) => void;
}): MiddlewareFunction {
  const now = options.now ?? (() => performance.now());
  return async (context, next) => {
    const startedAt = now();
    let failed = true;
    try {
      await next();
      failed = false;
    } finally {
      const requestContext = context.get("requestContext") as { get(key: string): unknown } | undefined;
      const applicationId = boundedIdentifier(requestContext?.get("applicationId"), "platform");
      const routeId = boundedIdentifier(
        requestContext?.get("platform-route-id"),
        publicRouteLabel(context.req.path),
      );
      const status = failed ? 500 : responseStatus(context.res);
      try {
        options.observe({
          applicationId,
          routeId,
          method: context.req.method,
          status,
          durationMs: Math.max(0, now() - startedAt),
        });
      } catch (error) {
        options.onObservationError?.(error instanceof Error ? error : new Error("HTTP observation failed"));
      }
    }
  };
}

function responseStatus(response: unknown): number {
  if (typeof response === "object" && response !== null && "status" in response
    && typeof response.status === "number") return response.status;
  return 200;
}

function boundedIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\r\n\0]/u.test(value)
    ? value
    : fallback;
}

function publicRouteLabel(path: string): string {
  if (path.endsWith("/healthz")) return "healthz";
  if (path.endsWith("/readyz")) return "readyz";
  return "unclassified";
}
