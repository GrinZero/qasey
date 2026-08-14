import { z } from "zod";

const optionalUrl = z.preprocess(value => value === "" ? undefined : value, z.url().optional());
const optionalString = z.preprocess(value => value === "" ? undefined : value, z.string().min(1).optional());
const optionalBoolean = z.preprocess(
  value => value === "" ? undefined : value,
  z.enum(["true", "false"]).optional(),
).transform(value => value === undefined ? undefined : value === "true");
const optionalCsv = z.preprocess(
  value => value === "" || value === undefined
    ? undefined
    : String(value).split(",").map(item => item.trim()).filter(Boolean),
  z.array(z.string().min(1)).optional(),
);

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: optionalString,
  EDITOR_DATABASE_URL: optionalString,
  OBSERVABILITY_DATABASE_URL: optionalString,
  MASTRA_ENCRYPTION_KEY: optionalString,
  MASTRA_LICENSE_KEY: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalUrl,
  GOOGLE_COOKIE_PASSWORD: z.preprocess(value => value === "" ? undefined : value, z.string().min(32).optional()),
  GOOGLE_ALLOWED_DOMAINS: optionalCsv,
  GOOGLE_HOSTED_DOMAIN: optionalString,
  SLACK_APP_CONFIG_REFRESH_TOKEN: optionalString,
  SLACK_BASE_URL: optionalUrl,
  SLACK_BOT_TOKEN: optionalString,
  SLACK_USER_TOKEN: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  SLACK_SOCKET_MODE_APP_TOKEN: optionalString,
  SLACK_RECEIVER_PORT: z.coerce.number().int().positive().default(3001),
  SLACK_BOT_USER_ID: z.string().default("U0BMP1SGB40"),
  JIRA_BASE_URL: optionalUrl,
  JIRA_EMAIL: optionalString,
  JIRA_API_TOKEN: optionalString,
  JIRA_WEBHOOK_TOKEN: optionalString,
  JIRA_QASEY_ACCOUNT_ID: z.string().default("712020:6095e32e-729d-4cd1-8585-a1d04e1f67d6"),
  QASEY_INGRESS_TOKEN: optionalString,
  GITHUB_TOKEN: optionalString,
  GITHUB_ORG: z.string().default("MoeGolibrary"),
  QASEY_ENABLE_DRAFT_PR: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_PUBLIC_BASE_URL: z.url().default("http://localhost:4111"),
  QASEY_MCP_CONFIG_FILE: z.string().default(".qasey/mcp.json"),
  QASEY_MCP_OAUTH_DIR: z.string().default(".qasey/oauth"),
  QASEY_ENABLE_STUDIO_EDITOR: optionalBoolean,
  QASEY_ENABLE_STUDIO_MCP_PREVIEW: optionalBoolean,
  QASEY_ENABLE_DATADOG: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_DATADOG_CAPTURE_CONTENT: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  DD_LLMOBS_ML_APP: optionalString,
  DD_SERVICE: z.string().min(1).default("qasey"),
  DD_ENV: optionalString,
  DD_VERSION: optionalString,
  QASEY_OBSERVABILITY_DB_PATH: z.string().min(1).default(".qasey/observability.duckdb"),
  // Legacy bearer configuration. Prefer QASEY_MCP_CONFIG_FILE, especially for OAuth servers.
  METERSPHERE_MCP_URL: optionalUrl,
  METERSPHERE_MCP_TOKEN: optionalString,
  FIGMA_MCP_URL: optionalUrl,
  FIGMA_MCP_TOKEN: optionalString,
  QA_EXPERIENCE_MCP_URL: optionalUrl,
  QA_EXPERIENCE_MCP_TOKEN: optionalString,
  MOEGO_RAG_MCP_URL: optionalUrl,
  MOEGO_RAG_MCP_TOKEN: optionalString,
  LARK_MCP_URL: optionalUrl,
  LARK_MCP_TOKEN: optionalString,
  QASEY_ENABLE_LOCAL_CODE_MODE: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_ENABLE_EXECUTION: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_ENABLE_CUA_FALLBACK: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
  QASEY_SHADOW_MODE: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  QASEY_WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  QASEY_JOB_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),
  QASEY_JOB_LEASE_MS: z.coerce.number().int().min(10_000).default(90_000),
  QASEY_AGENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(600_000),
  QASEY_MEMORY_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  QASEY_MEMORY_MESSAGE_TOKENS: z.coerce.number().int().min(5_000).default(30_000),
  QASEY_MEMORY_OBSERVATION_TOKENS: z.coerce.number().int().min(5_000).default(40_000),
  QASEY_MEMORY_INPUT_TOKEN_LIMIT: z.coerce.number().int().min(20_000).default(120_000),
  QASEY_ARTIFACT_DIR: z.string().default(".qasey/artifacts"),
  QASEY_WORKSPACE_DIR: z.string().default(".qasey/workspaces"),
  QASEY_ACP_COMMAND: z.string().default("codex-acp"),
  QASEY_ACP_ARGS: z.string().default("").transform(value => value.trim() ? value.trim().split(/\s+/) : []),
}).superRefine((value, context) => {
  if (value.QASEY_JOB_HEARTBEAT_MS * 2 >= value.QASEY_JOB_LEASE_MS) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_JOB_HEARTBEAT_MS"],
      message: "QASEY_JOB_HEARTBEAT_MS must be less than half of QASEY_JOB_LEASE_MS",
    });
  }
  if (value.QASEY_MEMORY_INPUT_TOKEN_LIMIT <= value.QASEY_MEMORY_MESSAGE_TOKENS + value.QASEY_MEMORY_OBSERVATION_TOKENS) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_MEMORY_INPUT_TOKEN_LIMIT"],
      message: "QASEY_MEMORY_INPUT_TOKEN_LIMIT must exceed the combined observational memory thresholds",
    });
  }
  if (value.NODE_ENV === "production") {
    for (const key of ["DATABASE_URL", "MASTRA_LICENSE_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_COOKIE_PASSWORD"] as const) {
      if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in production` });
    }
  }
  if (value.QASEY_ENABLE_DATADOG && !value.DD_LLMOBS_ML_APP) {
    context.addIssue({
      code: "custom",
      path: ["DD_LLMOBS_ML_APP"],
      message: "DD_LLMOBS_ML_APP is required when QASEY_ENABLE_DATADOG=true",
    });
  }
});

export type QaseyConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): QaseyConfig {
  return ConfigSchema.parse(env);
}
