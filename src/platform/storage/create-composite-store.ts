import { resolve } from "node:path";
import { DuckDBStore } from "@mastra/duckdb";
import { FilesystemStore, MastraCompositeStore } from "@mastra/core/storage";
import { ObservabilityStoragePostgresVNext, PostgresStore } from "@mastra/pg";

export interface CompositeStoreOptions {
  environment: string;
  projectRoot: string;
  databaseUrl?: string;
  observabilityDatabaseUrl?: string;
  editorDatabaseUrl?: string;
  observabilityDbPath: string;
  editorEnabled: boolean;
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
  if (options.environment === "production" && options.editorEnabled && !options.editorDatabaseUrl) {
    throw new Error("editorDatabaseUrl is required when the editor is enabled in production");
  }
  const primary = options.databaseUrl
    ? new PostgresStore({
        id: "shared-mastra-primary",
        connectionString: options.databaseUrl,
        ...(options.disableInit === undefined ? {} : { disableInit: options.disableInit }),
      })
    : undefined;
  const editor = options.editorEnabled
    ? options.editorDatabaseUrl
      ? new PostgresStore({
          id: "shared-mastra-editor",
          connectionString: options.editorDatabaseUrl,
          ...(options.disableInit === undefined ? {} : { disableInit: options.disableInit }),
        })
      : new FilesystemStore({ dir: resolve(options.projectRoot, ".qasey/mastra-editor") })
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
      ...(editor ? { editor } : {}),
      domains: { observability },
      ...(options.disableInit === undefined ? {} : { disableInit: options.disableInit }),
    }),
    ...(primary ? { primary } : {}),
  };
}

