import { z } from "zod";

const optionalUrl = z.preprocess(value => value === "" ? undefined : value, z.url().optional());
const optionalString = z.preprocess(value => value === "" ? undefined : value, z.string().min(1).optional());
const optionalPositiveInteger = z.preprocess(
  value => value === "" || value === undefined ? undefined : value,
  z.coerce.number().int().positive().optional(),
);
const optionalBoolean = z.preprocess(
  value => value === "" ? undefined : typeof value === "string" ? value.toLowerCase() : value,
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
  PG_URL: optionalString,
  PG_PORT: z.coerce.number().int().positive().max(65_535).optional(),
  PG_QASEY_USER_NAME: optionalString,
  PG_QASEY_PASSWORD: optionalString,
  PG_QASEY_DATABASE_NAME: z.string().min(1).default("moego_qasey"),
  PG_QASEY_OBSERVABILITY_DATABASE_NAME: z.string().min(1).default("moego_qasey_observability"),
  MASTRA_ENCRYPTION_KEY: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalUrl,
  GOOGLE_COOKIE_PASSWORD: z.preprocess(value => value === "" ? undefined : value, z.string().min(32).optional()),
  GOOGLE_ALLOWED_DOMAINS: optionalCsv,
  GOOGLE_HOSTED_DOMAIN: optionalString,
  WORKER_TOKEN: optionalString,
  PLATFORM_SERVICE_TOKEN: optionalString,
  QASEY_DEV_AUTH_TOKEN: z.preprocess(
    value => value === "" ? undefined : value,
    z.string().min(32).optional(),
  ),
  QASEY_USE_REDIS_DURABILITY: optionalBoolean,
  REDIS_HOST: optionalString,
  REDIS_PORT: optionalPositiveInteger,
  REDIS_USERNAME: optionalString,
  REDIS_PASSWORD: optionalString,
  REDIS_TLS: optionalBoolean,
  REDIS_TLS_SERVERNAME: optionalString,
  SLACK_BASE_URL: optionalUrl,
  SLACK_BOT_TOKEN: optionalString,
  SLACK_USER_TOKEN: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  SLACK_SOCKET_MODE_APP_TOKEN: optionalString,
  SLACK_CHANNEL_MODE: z.enum(["auto", "webhook", "socket"]).default("auto"),
  SLACK_BOT_USER_ID: z.string().default("U0BMP1SGB40"),
  JIRA_BASE_URL: optionalUrl,
  JIRA_EMAIL: optionalString,
  JIRA_API_TOKEN: optionalString,
  JIRA_WEBHOOK_TOKEN: optionalString,
  JIRA_QASEY_ACCOUNT_ID: z.string().default("712020:6095e32e-729d-4cd1-8585-a1d04e1f67d6"),
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_INSTALLATION_ID: optionalPositiveInteger,
  GITHUB_APP_PRIVATE_KEY: optionalString,
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
  METERSPHERE_BASE_URL: z.url().default("https://metersphere.devops.moego.pet"),
  METERSPHERE_PROJECT_ID: z.string().uuid().default("20a78db9-19aa-11ee-a261-5a66b98c4036"),
  QASEY_ENABLE_CODE_MODE: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  QASEY_CODE_MODE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
  QASEY_CODE_MODE_MEMORY_LIMIT_MB: z.coerce.number().int().min(32).max(512).default(128),
  QASEY_ENABLE_LOCAL_CODE_MODE: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_ENABLE_EXECUTION: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_ENABLE_CUA_FALLBACK: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
  QASEY_SHADOW_MODE: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  QASEY_INTENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  QASEY_AGENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(1_800_000),
  QASEY_MEMORY_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  QASEY_MEMORY_MESSAGE_TOKENS: z.coerce.number().int().min(5_000).default(30_000),
  QASEY_MEMORY_OBSERVATION_TOKENS: z.coerce.number().int().min(5_000).default(40_000),
  QASEY_MEMORY_INPUT_TOKEN_LIMIT: z.coerce.number().int().min(20_000).default(120_000),
  QASEY_ARTIFACT_DIR: z.string().default(".qasey/artifacts"),
  QASEY_WORKSPACE_DIR: z.string().default(".qasey/workspaces"),
  QASEY_DATA_ROOT: z.string().default(".qasey/data"),
  QASEY_SANDBOX_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_SANDBOX_ENDPOINT_TEMPLATE: z.string().min(1).default("http://moego-qasey-sandbox-{ordinal}.moego-qasey-sandbox:4120"),
  QASEY_SANDBOX_REPLICAS: z.coerce.number().int().min(1).max(20).default(2),
  QASEY_SANDBOX_MAX_SESSIONS: z.coerce.number().int().min(1).max(50).default(5),
  QASEY_SANDBOX_IDLE_TTL_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
  QASEY_SANDBOX_DESKTOP_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_SANDBOX_DESKTOP_DISPLAY: z.coerce.number().int().min(1).max(999).default(99),
  QASEY_SANDBOX_DESKTOP_WIDTH: z.coerce.number().int().min(800).max(3840).default(1440),
  QASEY_SANDBOX_DESKTOP_HEIGHT: z.coerce.number().int().min(600).max(2160).default(900),
  QASEY_WORKSPACE_RETENTION_MS: z.coerce.number().int().min(60_000).default(7 * 24 * 60 * 60_000),
  QASEY_SANDBOX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(30 * 60_000),
  QASEY_ACP_COMMAND: z.string().default("codex-acp"),
  QASEY_ACP_ARGS: z.string().default("").transform(value => value.trim() ? value.trim().split(/\s+/) : []),
}).superRefine((value, context) => {
  if (value.QASEY_MEMORY_INPUT_TOKEN_LIMIT <= value.QASEY_MEMORY_MESSAGE_TOKENS + value.QASEY_MEMORY_OBSERVATION_TOKENS) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_MEMORY_INPUT_TOKEN_LIMIT"],
      message: "QASEY_MEMORY_INPUT_TOKEN_LIMIT must exceed the combined observational memory thresholds",
    });
  }
  if (value.NODE_ENV === "production") {
    for (const key of ["DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_COOKIE_PASSWORD", "WORKER_TOKEN"] as const) {
      if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in production` });
    }
    for (const key of ["REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD"] as const) {
      if (!value[key]) context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required by the production multi-pod Mastra runtime`,
      });
    }
    if (value.REDIS_TLS !== true) context.addIssue({
      code: "custom",
      path: ["REDIS_TLS"],
      message: "REDIS_TLS=true is required by the production multi-pod Mastra runtime",
    });
  }
  if (value.QASEY_USE_REDIS_DURABILITY && !value.REDIS_HOST) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_USE_REDIS_DURABILITY"],
      message: "QASEY_USE_REDIS_DURABILITY=true requires REDIS_HOST",
    });
  }
  if (value.WORKER_TOKEN && value.PLATFORM_SERVICE_TOKEN && value.WORKER_TOKEN === value.PLATFORM_SERVICE_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["WORKER_TOKEN"],
      message: "WORKER_TOKEN must be distinct from PLATFORM_SERVICE_TOKEN",
    });
  }
  if (value.QASEY_DEV_AUTH_TOKEN && value.NODE_ENV === "production") {
    context.addIssue({
      code: "custom",
      path: ["QASEY_DEV_AUTH_TOKEN"],
      message: "QASEY_DEV_AUTH_TOKEN must not be configured in production",
    });
  }
  for (const [key, token] of [
    ["WORKER_TOKEN", value.WORKER_TOKEN],
    ["PLATFORM_SERVICE_TOKEN", value.PLATFORM_SERVICE_TOKEN],
    ["JIRA_WEBHOOK_TOKEN", value.JIRA_WEBHOOK_TOKEN],
  ] as const) {
    if (value.QASEY_DEV_AUTH_TOKEN && token === value.QASEY_DEV_AUTH_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["QASEY_DEV_AUTH_TOKEN"],
        message: `QASEY_DEV_AUTH_TOKEN must be distinct from ${key}`,
      });
    }
  }
  if (value.QASEY_ENABLE_DATADOG && !value.DD_LLMOBS_ML_APP) {
    context.addIssue({
      code: "custom",
      path: ["DD_LLMOBS_ML_APP"],
      message: "DD_LLMOBS_ML_APP is required when QASEY_ENABLE_DATADOG=true",
    });
  }
  if (value.QASEY_SANDBOX_ENABLED && !value.QASEY_SANDBOX_ENDPOINT_TEMPLATE.includes("{ordinal}")) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_SANDBOX_ENDPOINT_TEMPLATE"],
      message: "QASEY_SANDBOX_ENDPOINT_TEMPLATE must contain {ordinal}",
    });
  }
  if (value.NODE_ENV === "production" && value.QASEY_SANDBOX_ENABLED && (!value.DATABASE_URL || !value.GOOGLE_COOKIE_PASSWORD)) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_SANDBOX_ENABLED"],
      message: "Production sandbox leases require DATABASE_URL and GOOGLE_COOKIE_PASSWORD",
    });
  }
  const githubAppKeys = ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"] as const;
  const configuredGitHubAppKeys = githubAppKeys.filter(key => value[key] !== undefined);
  if (configuredGitHubAppKeys.length > 0 && configuredGitHubAppKeys.length < githubAppKeys.length) {
    for (const key of githubAppKeys.filter(key => value[key] === undefined)) {
      context.addIssue({ code: "custom", path: [key], message: `${key} is required when GitHub App authentication is configured` });
    }
  }
});

export type QaseyConfig = z.infer<typeof ConfigSchema>;

/** Use the distributed durable transport in production, or when a developer explicitly opts in. */
export function resolveRedisDurabilityEnabled(
  config: Pick<QaseyConfig, "NODE_ENV" | "QASEY_USE_REDIS_DURABILITY">,
): boolean {
  return config.NODE_ENV === "production" || config.QASEY_USE_REDIS_DURABILITY === true;
}

export function resolveSlackChannelMode(
  config: Pick<QaseyConfig, "NODE_ENV" | "SLACK_CHANNEL_MODE" | "SLACK_SIGNING_SECRET" | "SLACK_SOCKET_MODE_APP_TOKEN">,
): "webhook" | "socket" | undefined {
  if (config.SLACK_CHANNEL_MODE === "webhook") return config.SLACK_SIGNING_SECRET ? "webhook" : undefined;
  if (config.SLACK_CHANNEL_MODE === "socket") return config.SLACK_SOCKET_MODE_APP_TOKEN ? "socket" : undefined;
  if (config.NODE_ENV !== "production" && config.SLACK_SOCKET_MODE_APP_TOKEN) return "socket";
  if (config.SLACK_SIGNING_SECRET) return "webhook";
  return config.SLACK_SOCKET_MODE_APP_TOKEN ? "socket" : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): QaseyConfig {
  const splitPostgresValues = [env.PG_URL, env.PG_PORT, env.PG_QASEY_USER_NAME, env.PG_QASEY_PASSWORD];
  const hasCompleteSplitPostgresConfig = splitPostgresValues.every(Boolean);
  const mustValidateSplitPostgresConfig = env.NODE_ENV !== "test" && splitPostgresValues.some(Boolean);
  const databaseUrls = env.DATABASE_URL && env.OBSERVABILITY_DATABASE_URL
    ? undefined
    : hasCompleteSplitPostgresConfig || mustValidateSplitPostgresConfig
      ? databaseUrlsFromPgParts(env)
      : undefined;
  return ConfigSchema.parse({
    ...env,
    ...(env.DATABASE_URL ? {} : { DATABASE_URL: databaseUrls?.application }),
    // Split deployment credentials are also used by local development to
    // reach the shared application database. Do not silently opt a local
    // `pnpm dev` process into the remote observability database: its schema
    // initialization can take tens of seconds and blocks every first Studio
    // API request through Mastra's composite-store init barrier. Production
    // keeps the derived durable database; developers can still opt in with an
    // explicit OBSERVABILITY_DATABASE_URL.
    ...(env.OBSERVABILITY_DATABASE_URL || env.NODE_ENV !== "production"
      ? {}
      : { OBSERVABILITY_DATABASE_URL: databaseUrls?.observability }),
  });
}

export function databaseUrlsFromPgParts(
  env: NodeJS.ProcessEnv,
): { application: string; observability: string } | undefined {
  const values = [env.PG_URL, env.PG_PORT, env.PG_QASEY_USER_NAME, env.PG_QASEY_PASSWORD];
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value)) {
    throw new Error(
      "PG_URL, PG_PORT, PG_QASEY_USER_NAME and PG_QASEY_PASSWORD must be provided together",
    );
  }

  const applicationDatabase = env.PG_QASEY_DATABASE_NAME?.trim() || "moego_qasey";
  const observabilityDatabase = env.PG_QASEY_OBSERVABILITY_DATABASE_NAME?.trim() || "moego_qasey_observability";
  return {
    application: postgresUrl(env, applicationDatabase),
    observability: postgresUrl(env, observabilityDatabase),
  };
}

function postgresUrl(env: NodeJS.ProcessEnv, databaseName: string): string {
  const rawHost = env.PG_URL ?? "";
  const url = new URL(rawHost.includes("://") ? rawHost : `postgresql://${rawHost}`);
  url.protocol = "postgresql:";
  url.username = env.PG_QASEY_USER_NAME ?? "";
  url.password = env.PG_QASEY_PASSWORD ?? "";
  url.port = env.PG_PORT ?? "5432";
  url.pathname = `/${databaseName}`;
  return url.toString();
}
