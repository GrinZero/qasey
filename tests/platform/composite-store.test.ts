import { afterEach, describe, expect, it } from "vitest";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { createCompositeStore } from "../../src/platform/storage/create-composite-store.ts";

const stores: MastraCompositeStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
});

function productionStore() {
  const result = createCompositeStore({
    environment: "production",
    projectRoot: process.cwd(),
    databaseUrl: "postgresql://localhost/qasey",
    observabilityDatabaseUrl: "postgresql://localhost/qasey_observability",
    observabilityDbPath: ":memory:",
    disableInit: true,
  });
  stores.push(result.storage);
  return result;
}

function requireDomains(store: MastraCompositeStore) {
  if (!store.stores) throw new Error("Expected composite storage domains");
  return store.stores;
}

describe("composite storage routing", () => {
  it("uses the production Postgres store for application domains", () => {
    const result = productionStore();
    if (!result.primary) throw new Error("Expected primary Postgres store");
    const runtimeDomains = requireDomains(result.storage);

    expect(runtimeDomains.agents).toBe(result.primary.stores.agents);
    expect(runtimeDomains.promptBlocks).toBe(result.primary.stores.promptBlocks);
    expect(runtimeDomains.skills).toBe(result.primary.stores.skills);
  });
});
