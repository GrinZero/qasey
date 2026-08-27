import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from "@mastra/core/storage";
import { ObservabilityStoragePostgresVNext, PostgresStore } from "@mastra/pg";

export interface CompositeStoreOptions {
  environment: string;
  projectRoot: string;
  databaseUrl?: string;
  observabilityDatabaseUrl?: string;
  observabilityDbPath: string;
  disableInit?: boolean;
}

export interface CompositeStoreResult {
  storage: MastraCompositeStore;
  primary?: PostgresStore;
}

/** Compose Mastra-owned domains; Qasey domain repositories stay separate. */
export function createCompositeStore(options: CompositeStoreOptions): CompositeStoreResult {
  if (options.environment === "production" && !options.observabilityDatabaseUrl) {
    throw new Error("observabilityDatabaseUrl is required in production");
  }
  const primary = options.databaseUrl
    ? new PostgresStore({
        id: "shared-mastra-primary",
        connectionString: options.databaseUrl,
        ...(options.disableInit === undefined ? {} : { disableInit: options.disableInit }),
      })
    : undefined;
  const observability = options.observabilityDatabaseUrl
    ? new ObservabilityStoragePostgresVNext({ connectionString: options.observabilityDatabaseUrl })
    : new DuckDBStore({
        id: "shared-mastra-observability",
        path: options.observabilityDbPath,
        memoryLimit: "512MB",
        threads: 2,
      }).observability;
  return {
    storage: new MastraCompositeStore({
      id: "shared-mastra-runtime",
      ...(primary ? { default: primary } : {}),
      domains: { observability },
      ...(options.disableInit === undefined ? {} : { disableInit: options.disableInit }),
    }),
    ...(primary ? { primary } : {}),
  };
}
