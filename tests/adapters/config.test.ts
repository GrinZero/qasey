import { describe, expect, it } from "vitest";
import { loadConfig, resolveRedisDurabilityEnabled, resolveSlackChannelMode } from "../../packages/adapters/src/index.ts";

const productionAuth = {
  DATABASE_URL: "postgresql://qasey.example/moego_qasey",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
  WORKER_TOKEN: "dedicated-worker-token",
  REDIS_HOST: "redis.internal",
  REDIS_PORT: "6379",
  REDIS_PASSWORD: "redis-password",
  REDIS_TLS: "true",
};

describe("shared runtime configuration", () => {
  it("uses native workflow and memory defaults", () => {
    const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(config.QASEY_INTENT_TIMEOUT_MS).toBe(60_000);
    expect(config.QASEY_AGENT_TIMEOUT_MS).toBe(1_800_000);
    expect(config.QASEY_MEMORY_MODEL).toBe("gpt-5.6-luna");
    expect(config.QASEY_MEMORY_MESSAGE_TOKENS).toBe(30_000);
    expect(config.QASEY_MEMORY_OBSERVATION_TOKENS).toBe(40_000);
    expect(config.QASEY_MEMORY_INPUT_TOKEN_LIMIT).toBe(120_000);
    expect(config.QASEY_ENABLE_STUDIO_EDITOR).toBeUndefined();
    expect(config.QASEY_ENABLE_STUDIO_MCP_PREVIEW).toBeUndefined();
    expect(config.QASEY_USE_REDIS_DURABILITY).toBeUndefined();
    expect(config.EDITOR_DATABASE_URL).toBeUndefined();
    expect(config.OBSERVABILITY_DATABASE_URL).toBeUndefined();
    expect(config.QASEY_ENABLE_DATADOG).toBe(false);
    expect(config.QASEY_DATADOG_CAPTURE_CONTENT).toBe(false);
    expect(config.DD_SERVICE).toBe("qasey");
    expect(config.METERSPHERE_BASE_URL).toBe("https://metersphere.devops.moego.pet");
    expect(config.METERSPHERE_PROJECT_ID).toBe("20a78db9-19aa-11ee-a261-5a66b98c4036");
    expect(config.SLACK_CHANNEL_MODE).toBe("auto");
    expect(config.SLACK_APP_CONFIG_TOKEN).toBeUndefined();
    expect(config.SLACK_APP_CONFIG_REFRESH_TOKEN).toBeUndefined();
  });

  it("accepts optional SlackProvider App Manifest credentials", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      SLACK_APP_CONFIG_TOKEN: "xoxe-config-token",
      SLACK_APP_CONFIG_REFRESH_TOKEN: "xoxe-refresh-token",
    } as NodeJS.ProcessEnv);

    expect(config.SLACK_APP_CONFIG_TOKEN).toBe("xoxe-config-token");
    expect(config.SLACK_APP_CONFIG_REFRESH_TOKEN).toBe("xoxe-refresh-token");
  });

  it("keeps Redis durability off locally unless explicitly enabled", () => {
    const local = loadConfig({
      NODE_ENV: "development",
      REDIS_HOST: "remote-redis.example",
    } as NodeJS.ProcessEnv);
    expect(resolveRedisDurabilityEnabled(local)).toBe(false);

    const optedIn = loadConfig({
      NODE_ENV: "development",
      QASEY_USE_REDIS_DURABILITY: "true",
      REDIS_HOST: "localhost",
    } as NodeJS.ProcessEnv);
    expect(resolveRedisDurabilityEnabled(optedIn)).toBe(true);

    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_USE_REDIS_DURABILITY: "true",
    } as NodeJS.ProcessEnv)).toThrow(/requires REDIS_HOST/);
  });

  it("uses Socket Mode locally and webhook mode in production when both are configured", () => {
    const credentials = {
      SLACK_CHANNEL_MODE: "auto" as const,
      SLACK_SIGNING_SECRET: "signing-secret",
      SLACK_SOCKET_MODE_APP_TOKEN: "xapp-token",
    };
    expect(resolveSlackChannelMode({ NODE_ENV: "development", ...credentials })).toBe("socket");
    expect(resolveSlackChannelMode({ NODE_ENV: "production", ...credentials })).toBe("webhook");
    expect(resolveSlackChannelMode({ NODE_ENV: "development", ...credentials, SLACK_CHANNEL_MODE: "webhook" })).toBe("webhook");
  });

  it("requires an LLM application name when Datadog is enabled", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_ENABLE_DATADOG: "true",
    } as NodeJS.ProcessEnv)).toThrow(/DD_LLMOBS_ML_APP/);

    const config = loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_ENABLE_DATADOG: "true",
      DD_LLMOBS_ML_APP: "qasey",
      DD_SERVICE: "qasey-worker",
      DD_ENV: "production",
      DD_VERSION: "2026.08.13",
      QASEY_DATADOG_CAPTURE_CONTENT: "true",
    } as NodeJS.ProcessEnv);
    expect(config.QASEY_ENABLE_DATADOG).toBe(true);
    expect(config.DD_SERVICE).toBe("qasey-worker");
    expect(config.QASEY_DATADOG_CAPTURE_CONTENT).toBe(true);
  });

  it("parses explicit Studio capability switches", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_ENABLE_STUDIO_EDITOR: "true",
      QASEY_ENABLE_STUDIO_MCP_PREVIEW: "false",
      EDITOR_DATABASE_URL: "postgresql://editor.example/moego_qasey_editor",
      OBSERVABILITY_DATABASE_URL: "postgresql://observability.example/moego_qasey_observability",
    } as NodeJS.ProcessEnv);

    expect(config.QASEY_ENABLE_STUDIO_EDITOR).toBe(true);
    expect(config.QASEY_ENABLE_STUDIO_MCP_PREVIEW).toBe(false);
    expect(config.EDITOR_DATABASE_URL).toContain("qasey_editor");
    expect(config.OBSERVABILITY_DATABASE_URL).toContain("moego_qasey_observability");
  });

  it("requires complete GitHub App installation authentication", () => {
    expect(() => loadConfig({ GITHUB_APP_ID: "123" } as NodeJS.ProcessEnv)).toThrow(/GITHUB_APP_INSTALLATION_ID/);
    const config = loadConfig({
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    } as NodeJS.ProcessEnv);
    expect(config.GITHUB_APP_ID).toBe("123");
    expect(config.GITHUB_APP_INSTALLATION_ID).toBe(456);
  });

  it("requires Google OAuth and a durable cookie password in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_COOKIE_PASSWORD: "short",
    } as NodeJS.ProcessEnv)).toThrow();
  });

  it("requires a dedicated Mastra worker token in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      WORKER_TOKEN: undefined,
    } as NodeJS.ProcessEnv)).toThrow(/WORKER_TOKEN/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      PLATFORM_SERVICE_TOKEN: productionAuth.WORKER_TOKEN,
    } as NodeJS.ProcessEnv)).toThrow(/distinct from PLATFORM_SERVICE_TOKEN/);
  });

  it("accepts a dedicated developer token locally, ignores it in tests, and rejects it in production", () => {
    const token = "dev-auth-token-that-is-at-least-32-characters";
    expect(loadConfig({
      NODE_ENV: "development",
      QASEY_DEV_AUTH_TOKEN: token,
    } as NodeJS.ProcessEnv).QASEY_DEV_AUTH_TOKEN).toBe(token);

    expect(loadConfig({
      NODE_ENV: "test",
      QASEY_DEV_AUTH_TOKEN: token,
    } as NodeJS.ProcessEnv).QASEY_DEV_AUTH_TOKEN).toBe(token);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_DEV_AUTH_TOKEN: token,
    } as NodeJS.ProcessEnv)).toThrow(/must not be configured in production/);
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_DEV_AUTH_TOKEN: "too-short",
    } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_DEV_AUTH_TOKEN: token,
      PLATFORM_SERVICE_TOKEN: token,
    } as NodeJS.ProcessEnv)).toThrow(/distinct from PLATFORM_SERVICE_TOKEN/);
  });

  it("requires shared Redis for the production multi-pod runtime", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      REDIS_HOST: undefined,
    } as NodeJS.ProcessEnv)).toThrow(/REDIS_HOST/);

    const config = loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      REDIS_HOST: "redis.ns-testing.svc.cluster.local",
      REDIS_TLS: "TRUE",
      REDIS_TLS_SERVERNAME: "master.redis.example.com",
    } as NodeJS.ProcessEnv);
    expect(config.REDIS_HOST).toBe("redis.ns-testing.svc.cluster.local");
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.REDIS_TLS).toBe(true);
    expect(config.REDIS_TLS_SERVERNAME).toBe("master.redis.example.com");
  });

  it("keeps the hard context limit above both observational memory windows", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_MEMORY_MESSAGE_TOKENS: "30000",
      QASEY_MEMORY_OBSERVATION_TOKENS: "40000",
      QASEY_MEMORY_INPUT_TOKEN_LIMIT: "70000",
    } as NodeJS.ProcessEnv)).toThrow(/combined observational memory thresholds/);
  });
});
