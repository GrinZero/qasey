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

export function loadMcpServerConfigs(config: QaseyConfig): McpServerConfigs {
  const path = resolve(config.QASEY_MCP_CONFIG_FILE);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const servers = Object.fromEntries(
    Object.entries(McpConfigFileSchema.parse(parsed).servers).filter((entry): entry is [McpServerName, McpServerConfig] => Boolean(entry[1])),
  );
  if (config.QASEY_TENANCY_MODE === "multi" && Object.values(servers).some(server => server.auth.type !== "oauth")) {
    throw new Error(
      "multi-tenant static MCP configuration supports only subject-bound OAuth; configure bearer servers as tenant-owned external connections",
    );
  }
  return servers;
}
