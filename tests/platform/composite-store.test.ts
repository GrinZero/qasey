import { afterEach, describe, expect, it } from "vitest";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { createCompositeStore } from "../../src/platform/storage/create-composite-store.ts";

const stores: MastraCompositeStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
});

function productionStore(editorDatabaseUrl?: string) {
  const result = createCompositeStore({
    environment: "production",
    projectRoot: process.cwd(),
    databaseUrl: "postgresql://localhost/qasey",
    observabilityDatabaseUrl: "postgresql://localhost/qasey_observability",
    ...(editorDatabaseUrl ? { editorDatabaseUrl } : {}),
    observabilityDbPath: ":memory:",
    editorEnabled: true,
    disableInit: true,
  });
  stores.push(result.storage);
  return result;
}

function requireDomains(store: MastraCompositeStore) {
  if (!store.stores) throw new Error("Expected composite storage domains");
  return store.stores;
}

describe("composite Editor storage routing", () => {
  it("uses the production default Postgres domains when no Editor override exists", () => {
    const result = productionStore();
    if (!result.primary) throw new Error("Expected primary Postgres store");
    const runtimeDomains = requireDomains(result.storage);

    expect(runtimeDomains.agents).toBe(result.primary.stores.agents);
    expect(runtimeDomains.promptBlocks).toBe(result.primary.stores.promptBlocks);
    expect(runtimeDomains.skills).toBe(result.primary.stores.skills);
  });

  it("uses a separate Postgres store only when an Editor URL is explicit", () => {
    const result = productionStore("postgresql://localhost/qasey_editor");
    if (!result.primary) throw new Error("Expected primary Postgres store");
    const runtimeDomains = requireDomains(result.storage);

    expect(runtimeDomains.agents).not.toBe(result.primary.stores.agents);
    expect(runtimeDomains.promptBlocks).not.toBe(result.primary.stores.promptBlocks);
  });
});
