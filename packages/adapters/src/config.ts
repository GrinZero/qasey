import { z } from "zod";

const optionalUrl = z.preprocess(value => value === "" ? undefined : value, z.url().optional());
const optionalString = z.preprocess(value => value === "" ? undefined : value, z.string().min(1).optional());
const optionalKey = z.preprocess(
  value => value === "" ? undefined : value,
  z.string().refine(value => Buffer.byteLength(value, "utf8") >= 32, "Key must contain at least 32 UTF-8 bytes").optional(),
);
const optionalBearerToken = z.preprocess(
  value => value === "" ? undefined : value,
  z.string().refine(value => Buffer.byteLength(value, "utf8") >= 32, "Bearer token must contain at least 32 UTF-8 bytes").optional(),
);
const optionalGitHubToken = z.preprocess(
  value => value === "" ? undefined : value,
  z.string().refine(
    value => Buffer.byteLength(value, "utf8") >= 32 && Buffer.byteLength(value, "utf8") <= 4_096,
    "GitHub token must contain between 32 and 4096 UTF-8 bytes",
  ).optional(),
);
const optionalPositiveInteger = z.preprocess(
  value => value === "" || value === undefined ? undefined : value,
  z.coerce.number().int().positive().optional(),
);
const optionalNonNegativeNumber = z.preprocess(
  value => value === "" || value === undefined ? undefined : value,
  z.coerce.number().finite().nonnegative().optional(),
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
const optionalOriginCsv = z.preprocess(
  value => value === "" || value === undefined
    ? undefined
    : String(value).split(",").map(item => item.trim()).filter(Boolean),
  z.array(z.url().refine(value => {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === "";
  }, "Trusted browser origins must be canonical HTTP(S) origins without paths, credentials, query strings, or fragments")).optional(),
);
const optionalInstanceId = z.preprocess(
  value => value === "" ? undefined : value,
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u).optional(),
);
const credentialKeyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const optionalCredentialKeyMap = z.preprocess(
  value => {
    if (value === "" || value === undefined) return undefined;
    if (typeof value !== "string") return value;
    try { return JSON.parse(value) as unknown; }
    catch { return value; }
  },
  z.record(credentialKeyId, z.string().refine(
    value => Buffer.byteLength(value, "utf8") >= 32,
    "Each previous key must contain at least 32 UTF-8 bytes",
  )).optional(),
);

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  QASEY_DEPLOYMENT_MODE: z.enum(["standalone", "distributed"]).default("standalone"),
  QASEY_TENANCY_MODE: z.enum(["single", "multi"]).default("single"),
  QASEY_SINGLE_TENANT_ID: optionalInstanceId,
  QASEY_DEPLOYMENT_ID: optionalInstanceId,
  QASEY_INSTANCE_ID: optionalInstanceId,
  DATABASE_URL: optionalString,
  OBSERVABILITY_DATABASE_URL: optionalString,
  PG_URL: optionalString,
  PG_PORT: z.coerce.number().int().positive().max(65_535).optional(),
  PG_QASEY_USER_NAME: optionalString,
  PG_QASEY_PASSWORD: optionalString,
  PG_QASEY_DATABASE_NAME: z.string().min(1).default("qasey"),
  PG_QASEY_OBSERVABILITY_DATABASE_NAME: z.string().min(1).default("qasey_observability"),
  MASTRA_ENCRYPTION_KEY: optionalKey,
  MASTRA_ENCRYPTION_ACTIVE_KEY_ID: credentialKeyId.default("default"),
  MASTRA_ENCRYPTION_PREVIOUS_KEYS: optionalCredentialKeyMap,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalUrl,
  GOOGLE_COOKIE_PASSWORD: z.preprocess(value => value === "" ? undefined : value, z.string().min(32).optional()),
  GOOGLE_ALLOWED_DOMAINS: optionalCsv,
  GOOGLE_HOSTED_DOMAIN: optionalString,
  QASEY_PASSWORD_AUTH_ENABLED: optionalBoolean,
  QASEY_PASSWORD_REGISTRATION_ENABLED: optionalBoolean,
  PLATFORM_LOCAL_ADMIN_EMAILS: optionalCsv,
  QASEY_CREDENTIAL_ENCRYPTION_KEY: optionalKey,
  QASEY_CREDENTIAL_ACTIVE_KEY_ID: credentialKeyId.default("default"),
  QASEY_CREDENTIAL_PREVIOUS_KEYS: optionalCredentialKeyMap,
  MASTRA_WORKERS: z.preprocess(
    value => value === "" ? undefined : value,
    z.enum(["false", "orchestration"]).optional(),
  ),
  MASTRA_STEP_EXECUTION_URL: optionalUrl,
  WORKER_TOKEN: optionalBearerToken,
  PLATFORM_SERVICE_TOKEN: optionalBearerToken,
  QASEY_DEV_AUTH_TOKEN: z.preprocess(
    value => value === "" ? undefined : value,
    z.string().min(32).optional(),
  ),
  QASEY_DEV_TUNNEL_ENABLED: optionalBoolean,
  QASEY_DEV_TUNNEL_BASE_URL: optionalUrl,
  QASEY_DEV_TUNNEL_TOKEN: optionalBearerToken,
  QASEY_DEV_RUNTIME_ID: z.preprocess(
    value => value === "" ? undefined : value,
    z.string().regex(/^local-[A-Z2-9]{8}$/u).optional(),
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
  SLACK_BOT_USER_ID: optionalString,
  JIRA_BASE_URL: optionalUrl,
  JIRA_EMAIL: optionalString,
  JIRA_API_TOKEN: optionalString,
  JIRA_WEBHOOK_TOKEN: optionalBearerToken,
  JIRA_QASEY_ACCOUNT_ID: z.string().min(1).default("qasey"),
  GITHUB_TOKEN: optionalGitHubToken,
  GITHUB_ORG: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,
  QASEY_PUBLIC_BASE_URL: z.url().default("http://localhost:4111"),
  QASEY_ADDITIONAL_TRUSTED_ORIGINS: optionalOriginCsv,
  QASEY_MCP_CONFIG_FILE: z.string().default("config/mcp.json"),
  QASEY_MCP_OAUTH_DIR: z.string().default(".qasey/oauth"),
  QASEY_ENABLE_STUDIO_MCP_PREVIEW: optionalBoolean,
  QASEY_ENABLE_DATADOG: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_DATADOG_CAPTURE_CONTENT: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  DD_LLMOBS_ML_APP: optionalString,
  DD_LLMOBS_AGENTLESS_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  DD_API_KEY: optionalString,
  DD_SITE: z.string().min(1).default("datadoghq.com"),
  DD_SERVICE: z.string().min(1).default("qasey"),
  DD_ENV: optionalString,
  DD_VERSION: optionalString,
  QASEY_OBSERVABILITY_DB_PATH: z.string().min(1).default(".qasey/observability.duckdb"),
  QASEY_ENABLE_CODE_MODE: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_CODE_MODE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
  QASEY_CODE_MODE_MEMORY_LIMIT_MB: z.coerce.number().int().min(32).max(512).default(128),
  QASEY_ENABLE_LOCAL_CODE_MODE: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
  QASEY_INTENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  QASEY_AGENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(50 * 60_000),
  QASEY_CONVERSATION_RECONCILER_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  QASEY_MAIN_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN: optionalNonNegativeNumber,
  QASEY_MODEL_OUTPUT_COST_MICROUSD_PER_TOKEN: optionalNonNegativeNumber,
  QASEY_RUN_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
  QASEY_RUN_RECONCILER_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  QASEY_REQUEST_BODY_MAX_BYTES: z.coerce.number().int().min(16_384).max(16 * 1024 * 1024).default(1024 * 1024),
  QASEY_STANDARD_TENANT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(6_000),
  QASEY_STANDARD_SUBJECT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  QASEY_EXPENSIVE_TENANT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
  QASEY_EXPENSIVE_SUBJECT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  QASEY_EXPENSIVE_TENANT_CONCURRENCY: z.coerce.number().int().min(1).max(1_000).default(4),
  QASEY_EXPENSIVE_LEASE_TTL_MS: z.coerce.number().int().min(60_000).max(24 * 60 * 60_000).default(60 * 60_000),
  QASEY_MEMORY_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  QASEY_MEMORY_MESSAGE_TOKENS: z.coerce.number().int().min(5_000).default(30_000),
  QASEY_MEMORY_OBSERVATION_TOKENS: z.coerce.number().int().min(5_000).default(40_000),
  QASEY_MEMORY_INPUT_TOKEN_LIMIT: z.coerce.number().int().min(20_000).default(120_000),
  QASEY_ARTIFACT_DIR: z.string().default(".qasey/artifacts"),
  QASEY_ARTIFACT_STORE: z.enum(["local", "s3"]).default("local"),
  QASEY_ARTIFACT_S3_BUCKET: optionalString,
  QASEY_ARTIFACT_S3_REGION: optionalString,
  QASEY_ARTIFACT_S3_ENDPOINT: optionalUrl,
  QASEY_ARTIFACT_S3_PREFIX: z.string().min(1).default("qasey-artifacts"),
  QASEY_ARTIFACT_S3_FORCE_PATH_STYLE: optionalBoolean,
  QASEY_ARTIFACT_S3_KMS_KEY_ID: optionalString,
  QASEY_ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
  QASEY_WORKSPACE_DIR: z.string().default(".qasey/workspaces"),
  QASEY_GIT_CACHE_DIR: z.string().default(".qasey/git-cache"),
  QASEY_DATA_ROOT: z.string().default(".qasey/data"),
  QASEY_SANDBOX_ENDPOINT_TEMPLATE: optionalString,
  QASEY_SANDBOX_CONTROL_KEY: optionalKey,
  QASEY_SANDBOX_LEASE_KEY: optionalKey,
  QASEY_SANDBOX_REPLICAS: z.coerce.number().int().min(1).max(20).default(2),
  QASEY_SANDBOX_MAX_SESSIONS: z.coerce.number().int().min(1).max(50).default(5),
  QASEY_SANDBOX_IDLE_TTL_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
  QASEY_SANDBOX_DESKTOP_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  QASEY_SANDBOX_DESKTOP_DISPLAY: z.coerce.number().int().min(1).max(999).default(99),
  QASEY_SANDBOX_DESKTOP_WIDTH: z.coerce.number().int().min(800).max(3840).default(1440),
  QASEY_SANDBOX_DESKTOP_HEIGHT: z.coerce.number().int().min(600).max(2160).default(900),
  QASEY_WORKSPACE_RETENTION_MS: z.coerce.number().int().min(60_000).default(7 * 24 * 60 * 60_000),
  QASEY_SANDBOX_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(30 * 60_000),
  QASEY_CODE_AGENT_MODEL: z.string().min(1).default("gpt-5.6-sol"),
  QASEY_CODE_AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(500).default(80),
}).superRefine((value, context) => {
  if ((value.QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN === undefined)
    !== (value.QASEY_MODEL_OUTPUT_COST_MICROUSD_PER_TOKEN === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN"],
      message: "Both model input and output cost rates must be configured together",
    });
  }
  if (value.QASEY_MEMORY_INPUT_TOKEN_LIMIT <= value.QASEY_MEMORY_MESSAGE_TOKENS + value.QASEY_MEMORY_OBSERVATION_TOKENS) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_MEMORY_INPUT_TOKEN_LIMIT"],
      message: "QASEY_MEMORY_INPUT_TOKEN_LIMIT must exceed the combined observational memory thresholds",
    });
  }
  if (value.QASEY_STANDARD_SUBJECT_REQUESTS_PER_MINUTE > value.QASEY_STANDARD_TENANT_REQUESTS_PER_MINUTE) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_STANDARD_SUBJECT_REQUESTS_PER_MINUTE"],
      message: "The standard subject request limit must not exceed the tenant limit",
    });
  }
  if (value.QASEY_EXPENSIVE_SUBJECT_REQUESTS_PER_MINUTE > value.QASEY_EXPENSIVE_TENANT_REQUESTS_PER_MINUTE) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_EXPENSIVE_SUBJECT_REQUESTS_PER_MINUTE"],
      message: "The expensive subject request limit must not exceed the tenant limit",
    });
  }
  if (value.NODE_ENV === "production") {
    if (value.QASEY_SANDBOX_MAX_SESSIONS !== 1) context.addIssue({
      code: "custom",
      path: ["QASEY_SANDBOX_MAX_SESSIONS"],
      message: "QASEY_SANDBOX_MAX_SESSIONS must be exactly 1 in production until per-session cgroup isolation is available",
    });
    for (const key of ["DATABASE_URL"] as const) {
      if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in production` });
    }
    const googleValues = [value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, value.GOOGLE_COOKIE_PASSWORD];
    const googleConfigured = googleValues.every(Boolean);
    if (googleValues.some(Boolean) && !googleConfigured) {
      for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_COOKIE_PASSWORD"] as const) {
        if (!value[key]) context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when Google login is configured`,
        });
      }
    }
    if (!googleConfigured && value.QASEY_PASSWORD_AUTH_ENABLED !== true) context.addIssue({
      code: "custom",
      path: ["QASEY_PASSWORD_AUTH_ENABLED"],
      message: "Production requires Google login or QASEY_PASSWORD_AUTH_ENABLED=true",
    });
    if (!value.QASEY_INSTANCE_ID) context.addIssue({
      code: "custom",
      path: ["QASEY_INSTANCE_ID"],
      message: "QASEY_INSTANCE_ID is required in production for operational attribution",
    });
    if (!value.QASEY_DEPLOYMENT_ID) context.addIssue({
      code: "custom",
      path: ["QASEY_DEPLOYMENT_ID"],
      message: "QASEY_DEPLOYMENT_ID is required in production as the shared replica namespace",
    });
    if (!value.DD_VERSION) context.addIssue({
      code: "custom",
      path: ["DD_VERSION"],
      message: "DD_VERSION is required in production as the immutable release identifier",
    });
    if (value.QASEY_DEPLOYMENT_MODE === "distributed") {
      if (!value.WORKER_TOKEN) context.addIssue({
        code: "custom",
        path: ["WORKER_TOKEN"],
        message: "WORKER_TOKEN is required in distributed production mode",
      });
      for (const key of ["REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD"] as const) {
        if (!value[key]) context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required by the distributed Mastra runtime`,
        });
      }
      if (value.REDIS_TLS !== true) context.addIssue({
        code: "custom",
        path: ["REDIS_TLS"],
        message: "REDIS_TLS=true is required by the distributed Mastra runtime",
      });
    }
    if (value.QASEY_TENANCY_MODE === "single" && !value.QASEY_SINGLE_TENANT_ID) context.addIssue({
      code: "custom",
      path: ["QASEY_SINGLE_TENANT_ID"],
      message: "QASEY_SINGLE_TENANT_ID is required in production single-tenant mode",
    });
    if (googleConfigured && !value.GOOGLE_HOSTED_DOMAIN && !value.GOOGLE_ALLOWED_DOMAINS?.length) context.addIssue({
      code: "custom",
      path: ["GOOGLE_ALLOWED_DOMAINS"],
      message: "Production Google login requires GOOGLE_ALLOWED_DOMAINS or GOOGLE_HOSTED_DOMAIN",
    });
    if (!value.QASEY_CREDENTIAL_ENCRYPTION_KEY) context.addIssue({
      code: "custom",
      path: ["QASEY_CREDENTIAL_ENCRYPTION_KEY"],
      message: "QASEY_CREDENTIAL_ENCRYPTION_KEY is required in production",
    });
  }
  if (value.QASEY_PASSWORD_REGISTRATION_ENABLED === true && value.QASEY_PASSWORD_AUTH_ENABLED === false) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_PASSWORD_REGISTRATION_ENABLED"],
      message: "Password registration requires QASEY_PASSWORD_AUTH_ENABLED=true",
    });
  }
  if (value.NODE_ENV === "production" && value.PLATFORM_LOCAL_ADMIN_EMAILS?.length) {
    context.addIssue({
      code: "custom",
      path: ["PLATFORM_LOCAL_ADMIN_EMAILS"],
      message: "PLATFORM_LOCAL_ADMIN_EMAILS is development-only and must not be configured in production",
    });
  }
  if (value.QASEY_TENANCY_MODE === "multi"
    && (value.QASEY_PASSWORD_AUTH_ENABLED === true || value.QASEY_PASSWORD_REGISTRATION_ENABLED === true)) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_PASSWORD_AUTH_ENABLED"],
      message: "Password authentication is limited to explicit single-tenant installations",
    });
  }
  if (value.QASEY_TENANCY_MODE === "multi") {
    const globalConnectionKeys = [
      "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_SOCKET_MODE_APP_TOKEN",
      "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_WEBHOOK_TOKEN",
      "GITHUB_TOKEN", "GITHUB_ORG", "GITHUB_WEBHOOK_SECRET",
    ] as const;
    for (const key of globalConnectionKeys) {
      if (value[key] !== undefined) context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is a process-global connection and is not allowed in multi-tenant mode`,
      });
    }
  }
  const credentialKeys = [
    ...(value.QASEY_CREDENTIAL_ENCRYPTION_KEY
      ? [[value.QASEY_CREDENTIAL_ACTIVE_KEY_ID, value.QASEY_CREDENTIAL_ENCRYPTION_KEY] as const]
      : []),
    ...Object.entries(value.QASEY_CREDENTIAL_PREVIOUS_KEYS ?? {}),
  ];
  if (value.QASEY_CREDENTIAL_PREVIOUS_KEYS?.[value.QASEY_CREDENTIAL_ACTIVE_KEY_ID] !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_CREDENTIAL_PREVIOUS_KEYS"],
      message: "Previous credential keys must not redefine the active key ID",
    });
  }
  if (credentialKeys.length > 16) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_CREDENTIAL_PREVIOUS_KEYS"],
      message: "Credential keyring supports at most 16 keys",
    });
  }
  if (new Set(credentialKeys.map(([, key]) => key)).size !== credentialKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_CREDENTIAL_PREVIOUS_KEYS"],
      message: "Credential key IDs must map to distinct key material",
    });
  }
  if (value.QASEY_CREDENTIAL_PREVIOUS_KEYS && !value.QASEY_CREDENTIAL_ENCRYPTION_KEY) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_CREDENTIAL_ENCRYPTION_KEY"],
      message: "An active credential encryption key is required when previous keys are configured",
    });
  }
  const oauthKeys = [
    ...(value.MASTRA_ENCRYPTION_KEY
      ? [[value.MASTRA_ENCRYPTION_ACTIVE_KEY_ID, value.MASTRA_ENCRYPTION_KEY] as const]
      : []),
    ...Object.entries(value.MASTRA_ENCRYPTION_PREVIOUS_KEYS ?? {}),
  ];
  if (value.MASTRA_ENCRYPTION_PREVIOUS_KEYS?.[value.MASTRA_ENCRYPTION_ACTIVE_KEY_ID] !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["MASTRA_ENCRYPTION_PREVIOUS_KEYS"],
      message: "Previous MCP OAuth keys must not redefine the active key ID",
    });
  }
  if (oauthKeys.length > 16) {
    context.addIssue({
      code: "custom",
      path: ["MASTRA_ENCRYPTION_PREVIOUS_KEYS"],
      message: "MCP OAuth keyring supports at most 16 keys",
    });
  }
  if (new Set(oauthKeys.map(([, key]) => key)).size !== oauthKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["MASTRA_ENCRYPTION_PREVIOUS_KEYS"],
      message: "MCP OAuth key IDs must map to distinct key material",
    });
  }
  if (value.MASTRA_ENCRYPTION_PREVIOUS_KEYS && !value.MASTRA_ENCRYPTION_KEY) {
    context.addIssue({
      code: "custom",
      path: ["MASTRA_ENCRYPTION_KEY"],
      message: "An active MCP OAuth encryption key is required when previous keys are configured",
    });
  }
  const separatedKeys = [
    ["GOOGLE_COOKIE_PASSWORD", value.GOOGLE_COOKIE_PASSWORD],
    ["QASEY_SANDBOX_CONTROL_KEY", value.QASEY_SANDBOX_CONTROL_KEY],
    ["QASEY_SANDBOX_LEASE_KEY", value.QASEY_SANDBOX_LEASE_KEY],
    ["MASTRA_ENCRYPTION_KEY", value.MASTRA_ENCRYPTION_KEY],
  ] as const;
  for (const [key, secret] of separatedKeys) {
    if (secret && credentialKeys.some(([, credentialKey]) => secret === credentialKey)) context.addIssue({
      code: "custom",
      path: ["QASEY_CREDENTIAL_ENCRYPTION_KEY"],
      message: `Credential encryption keys must be distinct from ${key}`,
    });
  }
  for (const [key, secret] of [
    ["GOOGLE_COOKIE_PASSWORD", value.GOOGLE_COOKIE_PASSWORD],
    ["QASEY_SANDBOX_CONTROL_KEY", value.QASEY_SANDBOX_CONTROL_KEY],
    ["QASEY_SANDBOX_LEASE_KEY", value.QASEY_SANDBOX_LEASE_KEY],
  ] as const) {
    if (secret && oauthKeys.some(([, oauthKey]) => secret === oauthKey)) context.addIssue({
      code: "custom",
      path: ["MASTRA_ENCRYPTION_KEY"],
      message: `MCP OAuth encryption keys must be distinct from ${key}`,
    });
  }
  if (value.MASTRA_WORKERS === "orchestration") {
    if (!value.WORKER_TOKEN) context.addIssue({
      code: "custom",
      path: ["WORKER_TOKEN"],
      message: "WORKER_TOKEN is required by the orchestration Worker",
    });
    if (!value.MASTRA_STEP_EXECUTION_URL) {
      context.addIssue({
        code: "custom",
        path: ["MASTRA_STEP_EXECUTION_URL"],
        message: "MASTRA_STEP_EXECUTION_URL is required by the orchestration Worker",
      });
    } else {
      const stepExecutionUrl = new URL(value.MASTRA_STEP_EXECUTION_URL);
      const localHostname = ["localhost", "127.0.0.1", "[::1]"].includes(stepExecutionUrl.hostname);
      const secure = stepExecutionUrl.protocol === "https:"
        || value.NODE_ENV !== "production" && stepExecutionUrl.protocol === "http:" && localHostname;
      if (!secure || stepExecutionUrl.username || stepExecutionUrl.password) context.addIssue({
        code: "custom",
        path: ["MASTRA_STEP_EXECUTION_URL"],
        message: "MASTRA_STEP_EXECUTION_URL must use HTTPS; development and test may use local HTTP without URL credentials",
      });
    }
  }
  if (value.QASEY_USE_REDIS_DURABILITY && !value.REDIS_HOST) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_USE_REDIS_DURABILITY"],
      message: "QASEY_USE_REDIS_DURABILITY=true requires REDIS_HOST",
    });
  }
  if (value.QASEY_ARTIFACT_STORE === "s3") {
    for (const key of ["QASEY_ARTIFACT_S3_BUCKET", "QASEY_ARTIFACT_S3_REGION"] as const) {
      if (!value[key]) context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required when QASEY_ARTIFACT_STORE=s3`,
      });
    }
  }
  if (value.NODE_ENV === "production" && value.QASEY_DEPLOYMENT_MODE === "distributed" && value.QASEY_ARTIFACT_STORE !== "s3") {
    context.addIssue({
      code: "custom",
      path: ["QASEY_ARTIFACT_STORE"],
      message: "Distributed production requires QASEY_ARTIFACT_STORE=s3",
    });
  }
  if (value.NODE_ENV === "production" && value.QASEY_ARTIFACT_S3_ENDPOINT?.startsWith("http:")) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_ARTIFACT_S3_ENDPOINT"],
      message: "Production S3-compatible endpoints must use HTTPS",
    });
  }
  if (value.WORKER_TOKEN && value.PLATFORM_SERVICE_TOKEN && value.WORKER_TOKEN === value.PLATFORM_SERVICE_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["WORKER_TOKEN"],
      message: "WORKER_TOKEN must be distinct from PLATFORM_SERVICE_TOKEN",
    });
  }
  for (const [key, token] of [
    ["WORKER_TOKEN", value.WORKER_TOKEN],
    ["PLATFORM_SERVICE_TOKEN", value.PLATFORM_SERVICE_TOKEN],
    ["QASEY_DEV_AUTH_TOKEN", value.QASEY_DEV_AUTH_TOKEN],
  ] as const) {
    if (value.QASEY_DEV_TUNNEL_TOKEN && value.QASEY_DEV_TUNNEL_TOKEN === token) {
      context.addIssue({
        code: "custom",
        path: ["QASEY_DEV_TUNNEL_TOKEN"],
        message: `QASEY_DEV_TUNNEL_TOKEN must be distinct from ${key}`,
      });
    }
  }
  if (value.QASEY_DEV_AUTH_TOKEN && value.NODE_ENV === "production") {
    context.addIssue({
      code: "custom",
      path: ["QASEY_DEV_AUTH_TOKEN"],
      message: "QASEY_DEV_AUTH_TOKEN must not be configured in production",
    });
  }
  if (value.QASEY_DEV_TUNNEL_ENABLED && value.NODE_ENV === "production" && !value.QASEY_DEV_TUNNEL_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_DEV_TUNNEL_TOKEN"],
      message: "QASEY_DEV_TUNNEL_TOKEN is required by the testing tunnel server",
    });
  }
  for (const [key, token] of [
    ["WORKER_TOKEN", value.WORKER_TOKEN],
    ["PLATFORM_SERVICE_TOKEN", value.PLATFORM_SERVICE_TOKEN],
    ["JIRA_WEBHOOK_TOKEN", value.JIRA_WEBHOOK_TOKEN],
    ["QASEY_DEV_TUNNEL_TOKEN", value.QASEY_DEV_TUNNEL_TOKEN],
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
  if (value.QASEY_ENABLE_DATADOG && value.DD_LLMOBS_AGENTLESS_ENABLED && !value.DD_API_KEY) {
    context.addIssue({
      code: "custom",
      path: ["DD_API_KEY"],
      message: "DD_API_KEY is required when Datadog agentless mode is enabled",
    });
  }
  if (value.QASEY_SANDBOX_ENDPOINT_TEMPLATE && !value.QASEY_SANDBOX_ENDPOINT_TEMPLATE.includes("{ordinal}")) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_SANDBOX_ENDPOINT_TEMPLATE"],
      message: "QASEY_SANDBOX_ENDPOINT_TEMPLATE must contain {ordinal}",
    });
  }
  if (value.QASEY_SANDBOX_ENDPOINT_TEMPLATE) {
    for (const key of ["QASEY_SANDBOX_CONTROL_KEY", "QASEY_SANDBOX_LEASE_KEY"] as const) {
      if (!value[key]) context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required when the Sandbox pool is configured`,
      });
    }
    if (value.NODE_ENV === "production") {
      let secureEndpoint = false;
      try {
        secureEndpoint = new URL(value.QASEY_SANDBOX_ENDPOINT_TEMPLATE.replace("{ordinal}", "0")).protocol === "https:";
      } catch {
        // The endpoint validator below reports a single safe configuration error.
      }
      if (!secureEndpoint) context.addIssue({
        code: "custom",
        path: ["QASEY_SANDBOX_ENDPOINT_TEMPLATE"],
        message: "Production Sandbox endpoints must use HTTPS",
      });
    }
  }
  if (value.QASEY_SANDBOX_CONTROL_KEY && value.QASEY_SANDBOX_CONTROL_KEY === value.QASEY_SANDBOX_LEASE_KEY) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_SANDBOX_LEASE_KEY"],
      message: "QASEY_SANDBOX_LEASE_KEY must be distinct from QASEY_SANDBOX_CONTROL_KEY",
    });
  }
  if (value.NODE_ENV === "production" && value.QASEY_DEPLOYMENT_MODE === "distributed" && !value.QASEY_SANDBOX_ENDPOINT_TEMPLATE) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_SANDBOX_ENDPOINT_TEMPLATE"],
      message: "QASEY_SANDBOX_ENDPOINT_TEMPLATE is required in production",
    });
  }
  if (value.NODE_ENV === "production" && value.QASEY_SANDBOX_ENDPOINT_TEMPLATE && !value.DATABASE_URL) {
    context.addIssue({
      code: "custom",
      path: ["QASEY_SANDBOX_ENDPOINT_TEMPLATE"],
      message: "Production Sandbox leases require DATABASE_URL",
    });
  }
});

export type QaseyConfig = z.infer<typeof ConfigSchema>;

export interface RuntimeCredentialKeyring {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
}

/**
 * Build the process keyring without exposing key material in configuration
 * errors. The fallback is intentionally supplied by the caller so production
 * can never silently generate an ephemeral encryption key.
 */
export function resolveCredentialKeyring(
  config: Pick<QaseyConfig,
    "QASEY_CREDENTIAL_ACTIVE_KEY_ID" | "QASEY_CREDENTIAL_ENCRYPTION_KEY" | "QASEY_CREDENTIAL_PREVIOUS_KEYS">,
  fallbackKey?: string,
): RuntimeCredentialKeyring {
  const activeKey = config.QASEY_CREDENTIAL_ENCRYPTION_KEY ?? fallbackKey;
  if (!activeKey) throw new Error("Active credential encryption key is unavailable");
  if (config.QASEY_CREDENTIAL_PREVIOUS_KEYS?.[config.QASEY_CREDENTIAL_ACTIVE_KEY_ID] !== undefined) {
    throw new Error("Credential keyring redefines its active key ID");
  }
  return Object.freeze({
    activeKeyId: config.QASEY_CREDENTIAL_ACTIVE_KEY_ID,
    keys: Object.freeze({
      ...(config.QASEY_CREDENTIAL_PREVIOUS_KEYS ?? {}),
      [config.QASEY_CREDENTIAL_ACTIVE_KEY_ID]: activeKey,
    }),
  });
}

export function resolveMcpOAuthKeyring(
  config: Pick<QaseyConfig,
    "MASTRA_ENCRYPTION_ACTIVE_KEY_ID" | "MASTRA_ENCRYPTION_KEY" | "MASTRA_ENCRYPTION_PREVIOUS_KEYS">,
): RuntimeCredentialKeyring {
  if (!config.MASTRA_ENCRYPTION_KEY) throw new Error("Active MCP OAuth encryption key is unavailable");
  if (config.MASTRA_ENCRYPTION_PREVIOUS_KEYS?.[config.MASTRA_ENCRYPTION_ACTIVE_KEY_ID] !== undefined) {
    throw new Error("MCP OAuth keyring redefines its active key ID");
  }
  return Object.freeze({
    activeKeyId: config.MASTRA_ENCRYPTION_ACTIVE_KEY_ID,
    keys: Object.freeze({
      ...(config.MASTRA_ENCRYPTION_PREVIOUS_KEYS ?? {}),
      [config.MASTRA_ENCRYPTION_ACTIVE_KEY_ID]: config.MASTRA_ENCRYPTION_KEY,
    }),
  });
}

/** Use the distributed durable transport in production, or when a developer explicitly opts in. */
export function resolveRedisDurabilityEnabled(
  config: Pick<QaseyConfig, "QASEY_DEPLOYMENT_MODE" | "QASEY_USE_REDIS_DURABILITY">,
): boolean {
  return config.QASEY_DEPLOYMENT_MODE === "distributed" || config.QASEY_USE_REDIS_DURABILITY === true;
}

export function resolveSlackChannelMode(
  config: Pick<QaseyConfig, "NODE_ENV" | "SLACK_CHANNEL_MODE" | "SLACK_SIGNING_SECRET" | "SLACK_SOCKET_MODE_APP_TOKEN">
    & { QASEY_DEV_TUNNEL_ENABLED?: boolean | undefined },
): "webhook" | "socket" | undefined {
  if (config.NODE_ENV === "development" && config.QASEY_DEV_TUNNEL_ENABLED) return undefined;
  if (config.SLACK_CHANNEL_MODE === "webhook") return config.SLACK_SIGNING_SECRET ? "webhook" : undefined;
  if (config.SLACK_CHANNEL_MODE === "socket") return config.SLACK_SOCKET_MODE_APP_TOKEN ? "socket" : undefined;
  if (config.NODE_ENV !== "production" && config.SLACK_SOCKET_MODE_APP_TOKEN) return "socket";
  if (config.SLACK_SIGNING_SECRET) return "webhook";
  return config.SLACK_SOCKET_MODE_APP_TOKEN ? "socket" : undefined;
}

export function devRuntimeTunnelServerEnabled(
  config: Pick<QaseyConfig, "NODE_ENV" | "QASEY_DEV_TUNNEL_ENABLED" | "QASEY_DEV_TUNNEL_TOKEN">,
): boolean {
  return config.QASEY_DEV_TUNNEL_ENABLED === true
    && config.NODE_ENV === "production"
    && Boolean(config.QASEY_DEV_TUNNEL_TOKEN);
}

export function devRuntimeTunnelClientEnabled(
  config: Pick<QaseyConfig, "NODE_ENV" | "QASEY_DEV_TUNNEL_ENABLED" | "QASEY_DEV_TUNNEL_BASE_URL" | "QASEY_DEV_TUNNEL_TOKEN">,
): boolean {
  return config.QASEY_DEV_TUNNEL_ENABLED === true
    && config.NODE_ENV === "development"
    && Boolean(config.QASEY_DEV_TUNNEL_BASE_URL)
    && Boolean(config.QASEY_DEV_TUNNEL_TOKEN);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): QaseyConfig {
  if (env.QASEY_ENABLE_STUDIO_EDITOR?.trim().toLowerCase() === "true" || env.EDITOR_DATABASE_URL?.trim()) {
    throw new Error("The community build does not include Mastra Studio Editor; use the audited Admin UI instead");
  }
  const splitPostgresValues = [env.PG_URL, env.PG_PORT, env.PG_QASEY_USER_NAME, env.PG_QASEY_PASSWORD];
  const hasCompleteSplitPostgresConfig = splitPostgresValues.every(Boolean);
  const mustValidateSplitPostgresConfig = env.NODE_ENV !== "test" && splitPostgresValues.some(Boolean);
  const databaseUrls = env.DATABASE_URL && env.OBSERVABILITY_DATABASE_URL
    ? undefined
    : hasCompleteSplitPostgresConfig || mustValidateSplitPostgresConfig
      ? databaseUrlsFromPgParts(env)
      : undefined;
  const applicationDatabaseUrl = env.DATABASE_URL ?? databaseUrls?.application;
  const singleTenant = (env.QASEY_TENANCY_MODE ?? "single") === "single";
  const passwordAuthEnabled = env.QASEY_PASSWORD_AUTH_ENABLED?.trim()
    || (singleTenant ? "true" : "false");
  const passwordRegistrationEnabled = env.QASEY_PASSWORD_REGISTRATION_ENABLED?.trim()
    || passwordAuthEnabled;
  const standaloneProductionObservability = env.NODE_ENV === "production"
    && (env.QASEY_DEPLOYMENT_MODE ?? "standalone") === "standalone"
    ? applicationDatabaseUrl
    : undefined;
  return ConfigSchema.parse({
    ...env,
    // Single-tenant password login and registration are ready-to-use defaults
    // in every environment, including production. Multi-tenant deployments
    // remain fail-closed because local identities do not verify tenant access.
    QASEY_PASSWORD_AUTH_ENABLED: passwordAuthEnabled,
    QASEY_PASSWORD_REGISTRATION_ENABLED: passwordRegistrationEnabled,
    ...(env.NODE_ENV === "production" && !env.QASEY_SANDBOX_MAX_SESSIONS
      ? { QASEY_SANDBOX_MAX_SESSIONS: "1" }
      : {}),
    ...(env.DATABASE_URL ? {} : { DATABASE_URL: databaseUrls?.application }),
    // Split deployment credentials are also used by local development to
    // reach the shared application database. Do not silently opt a local
    // `pnpm dev` process into the remote observability database: its schema
    // initialization can take tens of seconds and blocks every first Studio
    // API request through Mastra's composite-store init barrier. Production
    // keeps the derived durable database; developers can still opt in with an
    // explicit OBSERVABILITY_DATABASE_URL.
    ...(env.OBSERVABILITY_DATABASE_URL
      ? {}
      : standaloneProductionObservability
        ? { OBSERVABILITY_DATABASE_URL: standaloneProductionObservability }
        : env.NODE_ENV !== "production"
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

  const applicationDatabase = env.PG_QASEY_DATABASE_NAME?.trim() || "qasey";
  const observabilityDatabase = env.PG_QASEY_OBSERVABILITY_DATABASE_NAME?.trim() || "qasey_observability";
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
