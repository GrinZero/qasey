import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileOAuthStorage, loadConfig, loadMcpServerConfigs } from "../../packages/adapters/src/index.ts";

describe("MCP configuration and OAuth storage", () => {
  it("loads only explicitly enabled OAuth servers without token env vars", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-mcp-config-"));
    try {
      const path = join(root, "mcp.json");
      await writeFile(path, JSON.stringify({ servers: { figma: { url: "https://mcp.example.test/mcp" } } }));
      const config = loadConfig({ QASEY_MCP_CONFIG_FILE: path });
      expect(loadMcpServerConfigs(config)).toEqual({
        figma: {
          url: "https://mcp.example.test/mcp",
          auth: { type: "oauth", redirectUrl: "http://127.0.0.1:31300/oauth/callback" },
          allowedHosts: [],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists local OAuth state outside environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-oauth-store-"));
    try {
      const storage = new FileOAuthStorage(join(root, "figma.json"));
      await storage.set("tokens", "refresh-token-value");
      await expect(storage.get("tokens")).resolves.toBe("refresh-token-value");
      await storage.delete("tokens");
      await expect(storage.get("tokens")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
