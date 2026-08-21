import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("patched Mastra Studio API prefix", () => {
  it("routes every skills.sh request through the configured client prefix", () => {
    const assets = new URL("../../node_modules/mastra/dist/studio/assets/", import.meta.url);
    const mainAsset = readdirSync(assets).find(file => /^main-.*\.js$/u.test(file));

    expect(mainAsset).toBeDefined();
    const source = readFileSync(new URL(mainAsset!, assets), "utf8");

    expect(source).not.toContain("/api/workspaces/");
    expect(source.match(/\$\{[a-z]\.apiPrefix\}\/workspaces\//gu)).toHaveLength(6);
  });
});
