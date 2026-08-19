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
  QASEY_ENABLE_LOCAL_CODE_MODE: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_ENABLE_EXECUTION: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_ENABLE_CUA_FALLBACK: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
  QASEY_SHADOW_MODE: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  QASEY_AGENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(1_800_000),
  QASEY_MEMORY_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  QASEY_MEMORY_MESSAGE_TOKENS: z.coerce.number().int().min(5_000).default(30_000),
  QASEY_MEMORY_OBSERVATION_TOKENS: z.coerce.number().int().min(5_000).default(40_000),
  QASEY_MEMORY_INPUT_TOKEN_LIMIT: z.coerce.number().int().min(20_000).default(120_000),
  QASEY_ARTIFACT_DIR: z.string().default(".qasey/artifacts"),
  QASEY_WORKSPACE_DIR: z.string().default(".qasey/workspaces"),
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
  if (value.WORKER_TOKEN && value.PLATFORM_SERVICE_TOKEN && value.WORKER_TOKEN === value.PLATFORM_SERVICE_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["WORKER_TOKEN"],
      message: "WORKER_TOKEN must be distinct from PLATFORM_SERVICE_TOKEN",
    });
  }
  if (value.QASEY_ENABLE_DATADOG && !value.DD_LLMOBS_ML_APP) {
    context.addIssue({
      code: "custom",
      path: ["DD_LLMOBS_ML_APP"],
      message: "DD_LLMOBS_ML_APP is required when QASEY_ENABLE_DATADOG=true",
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
    ...(env.OBSERVABILITY_DATABASE_URL ? {} : { OBSERVABILITY_DATABASE_URL: databaseUrls?.observability }),
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
