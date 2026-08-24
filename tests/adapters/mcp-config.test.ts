import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MCPClient } from "@mastra/mcp";
import { describe, expect, it, vi } from "vitest";
import {
  FileOAuthStorage,
  loadConfig,
  loadMcpServerConfigs,
  QaseyMcpCatalog,
  QASEY_REQUIRED_METERSPHERE_TOOL_NAMES,
} from "../../packages/adapters/src/index.ts";

describe("MCP configuration and OAuth storage", () => {
  it("defines the complete MeterSphere tool set required by the runtime", () => {
    expect(QASEY_REQUIRED_METERSPHERE_TOOL_NAMES).toEqual([
      "metersphere_ms_bulk_upsert_test_cases",
      "metersphere_ms_get_test_case_detail",
      "metersphere_ms_list_modules",
      "metersphere_ms_list_test_cases",
    ]);
  });

  it("fails readiness when MeterSphere is not configured", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      QASEY_MCP_CONFIG_FILE: "/path/that/does/not/exist.json",
    } as NodeJS.ProcessEnv);
    const catalog = new QaseyMcpCatalog(config);

    await expect(catalog.healthCheckRequiredMeterSphereTools()).rejects.toThrow(
      "Required MCP server is not configured: metersphere",
    );
    await catalog.close();
  });

  it("fails readiness when any required MeterSphere tool is not discovered", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-mcp-readiness-"));
    const path = join(root, "mcp.json");
    await writeFile(path, JSON.stringify({
      servers: { metersphere: { url: "https://mcp.example.test/mcp", auth: { type: "none" } } },
    }));
    const discovery = vi.spyOn(MCPClient.prototype, "listToolsWithErrors").mockResolvedValue({
      tools: Object.fromEntries(QASEY_REQUIRED_METERSPHERE_TOOL_NAMES
        .filter(name => name !== "metersphere_ms_get_test_case_detail")
        .map(name => [name, { id: name }])) as never,
      errors: {},
    });
    const catalog = new QaseyMcpCatalog(loadConfig({
      NODE_ENV: "test",
      QASEY_MCP_CONFIG_FILE: path,
    } as NodeJS.ProcessEnv));
    try {
      await expect(catalog.healthCheckRequiredMeterSphereTools()).rejects.toThrow(
        "Required MeterSphere MCP tools are unavailable: metersphere_ms_get_test_case_detail",
      );
    } finally {
      discovery.mockRestore();
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes readiness when the complete required MeterSphere tool set is discovered", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-mcp-readiness-"));
    const path = join(root, "mcp.json");
    await writeFile(path, JSON.stringify({
      servers: { metersphere: { url: "https://mcp.example.test/mcp", auth: { type: "none" } } },
    }));
    const discovery = vi.spyOn(MCPClient.prototype, "listToolsWithErrors").mockResolvedValue({
      tools: Object.fromEntries(QASEY_REQUIRED_METERSPHERE_TOOL_NAMES.map(name => [name, { id: name }])) as never,
      errors: {},
    });
    const catalog = new QaseyMcpCatalog(loadConfig({
      NODE_ENV: "test",
      QASEY_MCP_CONFIG_FILE: path,
    } as NodeJS.ProcessEnv));
    try {
      await expect(catalog.healthCheckRequiredMeterSphereTools()).resolves.toBeUndefined();
    } finally {
      discovery.mockRestore();
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes incompatible regex patterns discovered from MCP servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-mcp-schema-"));
    const path = join(root, "mcp.json");
    await writeFile(path, JSON.stringify({
      servers: { metersphere: { url: "https://mcp.example.test/mcp", auth: { type: "none" } } },
    }));
    const discovery = vi.spyOn(MCPClient.prototype, "listToolsWithErrors").mockResolvedValue({
      tools: {
        metersphere_ms_list_modules: {
          id: "metersphere_ms_list_modules",
          description: "fixture",
          inputSchema: {
            type: "object",
            properties: { email: { type: "string", format: "email", pattern: "^(?!\\.)[^@]+@[^@]+$" } },
          },
          execute: async () => ({ modules: [] }),
        },
      } as never,
      errors: {},
    });
    const catalog = new QaseyMcpCatalog(loadConfig({
      NODE_ENV: "test",
      QASEY_MCP_CONFIG_FILE: path,
    } as NodeJS.ProcessEnv));
    try {
      const tools = await catalog.toolsForDiscovery("api");
      expect((tools.metersphere_ms_list_modules as { inputSchema: unknown }).inputSchema).toEqual({
        type: "object",
        properties: { email: { type: "string", format: "email" } },
      });
    } finally {
      discovery.mockRestore();
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("does not fall back to legacy MCP URL and token environment variables", () => {
    const config = loadConfig({
      QASEY_MCP_CONFIG_FILE: "/path/that/does/not/exist.json",
      METERSPHERE_MCP_URL: "https://legacy.example.test/mcp",
      METERSPHERE_MCP_TOKEN: "legacy-token",
    } as NodeJS.ProcessEnv);
    expect(loadMcpServerConfigs(config)).toEqual({});
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
