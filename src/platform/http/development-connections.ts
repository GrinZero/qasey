import type { Middleware } from "@mastra/core/server";

/**
 * Mastra dev restarts replace the local HTTP server process. Persistent
 * browser connections to the previous process can otherwise remain in
 * CLOSE_WAIT and exhaust Chrome's per-origin connection pool, leaving Studio
 * API requests stalled before they ever reach the new server.
 *
 * This is deliberately development-only. Production keeps normal keep-alive
 * semantics for throughput and is expected to drain connections at the
 * ingress/load-balancer boundary during a rollout.
 */
export const closeDevelopmentConnections: Middleware = async (context, next) => {
  context.header("Connection", "close");
  await next();
};
