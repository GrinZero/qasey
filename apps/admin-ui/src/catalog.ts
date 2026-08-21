import type { CatalogEntry } from "./types";

const QASEY_TASK_PATH = "/v1/qasey/tasks";

/**
 * The Admin UI starts qasey-task through its domain-safe API ingress. Route
 * resource IDs are application-qualified at runtime, so path and method are
 * the stable identifiers exposed by the catalog.
 */
export function canRunQaseyTask(catalog: readonly CatalogEntry[]): boolean {
  return catalog.some(entry =>
    entry.applicationId === "qasey"
    && entry.resourceType === "route"
    && entry.routePath === QASEY_TASK_PATH
    && entry.routeMethod === "POST"
  );
}
