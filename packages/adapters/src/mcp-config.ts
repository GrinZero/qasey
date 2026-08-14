import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { QaseyConfig } from "./config.ts";

export const McpServerNameSchema = z.enum(["metersphere", "figma", "qaExperience", "rag", "lark"]);
export type McpServerName = z.infer<typeof McpServerNameSchema>;

const OAuthAuthSchema = z.object({
  type: z.literal("oauth"),
  redirectUrl: z.url().default("http://127.0.0.1:31300/oauth/callback"),
  scopes: z.array(z.string().min(1)).optional(),
  clientIdEnv: z.string().min(1).optional(),
  clientSecretEnv: z.string().min(1).optional(),
});

const BearerAuthSchema = z.object({
  type: z.literal("bearer"),
  tokenEnv: z.string().min(1),
});

export const McpServerConfigSchema = z.object({
  url: z.url(),
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    BearerAuthSchema,
    OAuthAuthSchema,
  ]).default({ type: "oauth", redirectUrl: "http://127.0.0.1:31300/oauth/callback" }),
  allowedHosts: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerConfigs = Partial<Record<McpServerName, McpServerConfig>>;

const McpConfigFileSchema = z.object({
  servers: z.object({
    metersphere: McpServerConfigSchema.optional(),
    figma: McpServerConfigSchema.optional(),
    qaExperience: McpServerConfigSchema.optional(),
    rag: McpServerConfigSchema.optional(),
    lark: McpServerConfigSchema.optional(),
  }).default({}),
});

const legacyServers: Array<[McpServerName, keyof QaseyConfig, keyof QaseyConfig, number]> = [
  ["metersphere", "METERSPHERE_MCP_URL", "METERSPHERE_MCP_TOKEN", 60_000],
  ["figma", "FIGMA_MCP_URL", "FIGMA_MCP_TOKEN", 120_000],
  ["qaExperience", "QA_EXPERIENCE_MCP_URL", "QA_EXPERIENCE_MCP_TOKEN", 60_000],
  ["rag", "MOEGO_RAG_MCP_URL", "MOEGO_RAG_MCP_TOKEN", 180_000],
  ["lark", "LARK_MCP_URL", "LARK_MCP_TOKEN", 60_000],
];

export function loadMcpServerConfigs(config: QaseyConfig): McpServerConfigs {
  const path = resolve(config.QASEY_MCP_CONFIG_FILE);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Object.fromEntries(
      Object.entries(McpConfigFileSchema.parse(parsed).servers).filter((entry): entry is [McpServerName, McpServerConfig] => Boolean(entry[1])),
    );
  }

  const servers: McpServerConfigs = {};
  for (const [name, urlKey, tokenKey, timeoutMs] of legacyServers) {
    const url = config[urlKey];
    const token = config[tokenKey];
    if (typeof url !== "string") continue;
    servers[name] = {
      url,
      auth: typeof token === "string" ? { type: "bearer", tokenEnv: String(tokenKey) } : { type: "none" },
      allowedHosts: [],
      timeoutMs,
    };
  }
  return servers;
}
