import type { Config as MastraConfig } from "@mastra/core/mastra";
import type { Middleware } from "@mastra/core/server";
import type { AgentApplicationBundle, CatalogEntry } from "./application.ts";
import { flattenApplicationRegistry } from "./registry-validator.ts";

export interface SharedRuntimeOptions {
  applications: readonly AgentApplicationBundle[];
  platform?: Omit<MastraConfig, "agents" | "workflows" | "scorers" | "server">;
  server?: Omit<NonNullable<MastraConfig["server"]>, "apiRoutes" | "middleware">;
  middleware?: Middleware | readonly Middleware[];
  middlewareFactory?: (catalog: readonly CatalogEntry[]) => Middleware | readonly Middleware[];
}

export interface SharedMastraConfig {
  config: MastraConfig;
  catalog: readonly CatalogEntry[];
}

/** Compose the application registry into the config consumed by the official Mastra entry point. */
export function createSharedMastraConfig(options: SharedRuntimeOptions): SharedMastraConfig {
  const registry = flattenApplicationRegistry(options.applications);
  const configuredMiddleware = options.middlewareFactory?.(registry.catalog) ?? options.middleware;
  const middleware = configuredMiddleware
    ? Array.isArray(configuredMiddleware) ? [...configuredMiddleware] : configuredMiddleware
    : undefined;
  const config: MastraConfig = {
    ...options.platform,
    agents: registry.agents,
    workflows: registry.workflows,
    ...(Object.keys(registry.scorers).length > 0 ? { scorers: registry.scorers } : {}),
    server: {
      ...options.server,
      apiRoutes: registry.routes,
      ...(middleware ? { middleware: middleware as Middleware | Middleware[] } : {}),
    },
  };
  return { config, catalog: registry.catalog };
}
