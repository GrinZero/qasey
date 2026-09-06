import { describe, expect, it } from "vitest";
import {
  devRuntimeTunnelClientEnabled,
  devRuntimeTunnelServerEnabled,
  loadConfig,
  resolveCredentialKeyring,
  resolveMcpOAuthKeyring,
  resolveRedisDurabilityEnabled,
  resolveSlackChannelMode,
} from "../../packages/adapters/src/index.ts";

const productionAuth = {
  QASEY_DEPLOYMENT_MODE: "distributed",
  QASEY_INSTANCE_ID: "production-a",
  QASEY_DEPLOYMENT_ID: "production",
  DD_VERSION: "sha256-release-a",
  DATABASE_URL: "postgresql://qasey.example/qasey",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
  GOOGLE_ALLOWED_DOMAINS: "example.com",
  QASEY_SINGLE_TENANT_ID: "example",
  QASEY_CREDENTIAL_ENCRYPTION_KEY: "connection-credential-key-over-32-bytes",
  WORKER_TOKEN: "dedicated-worker-token-with-at-least-32-bytes",
  REDIS_HOST: "redis.example.com",
  REDIS_PORT: "6379",
  REDIS_PASSWORD: "redis-password",
  REDIS_TLS: "true",
  QASEY_SANDBOX_ENDPOINT_TEMPLATE: "https://qasey-sandbox-{ordinal}.example.com",
  QASEY_SANDBOX_CONTROL_KEY: "sandbox-control-key-with-32-bytes-minimum",
  QASEY_SANDBOX_LEASE_KEY: "sandbox-lease-key-that-is-separate-32-bytes",
  QASEY_ARTIFACT_STORE: "s3",
  QASEY_ARTIFACT_S3_BUCKET: "qasey-production-artifacts",
  QASEY_ARTIFACT_S3_REGION: "us-east-1",
};

describe("shared runtime configuration", () => {
  it("uses native workflow and memory defaults", () => {
    const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(config.QASEY_INTENT_TIMEOUT_MS).toBe(60_000);
    expect(config.QASEY_AGENT_TIMEOUT_MS).toBe(3_000_000);
    expect(config.QASEY_CONVERSATION_RECONCILER_INTERVAL_MS).toBe(30_000);
    expect(config.QASEY_REQUEST_BODY_MAX_BYTES).toBe(1_048_576);
    expect(config.QASEY_STANDARD_TENANT_REQUESTS_PER_MINUTE).toBe(6_000);
    expect(config.QASEY_STANDARD_SUBJECT_REQUESTS_PER_MINUTE).toBe(600);
    expect(config.QASEY_EXPENSIVE_TENANT_CONCURRENCY).toBe(4);
    expect(config.QASEY_MAIN_MODEL).toBe("gpt-5.6-sol");
    expect(config.QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN).toBeUndefined();
    expect(config.QASEY_RUN_HEARTBEAT_TIMEOUT_MS).toBe(1_800_000);
    expect(config.QASEY_RUN_RECONCILER_INTERVAL_MS).toBe(30_000);
    expect(config.QASEY_MEMORY_MODEL).toBe("gpt-5.6-luna");
    expect(config.QASEY_MEMORY_MESSAGE_TOKENS).toBe(30_000);
    expect(config.QASEY_MEMORY_OBSERVATION_TOKENS).toBe(40_000);
    expect(config.QASEY_MEMORY_INPUT_TOKEN_LIMIT).toBe(120_000);
    expect(config.QASEY_ENABLE_STUDIO_MCP_PREVIEW).toBeUndefined();
    expect(config.QASEY_USE_REDIS_DURABILITY).toBeUndefined();
    expect(config.OBSERVABILITY_DATABASE_URL).toBeUndefined();
    expect(config.QASEY_ENABLE_DATADOG).toBe(false);
    expect(config.QASEY_DATADOG_CAPTURE_CONTENT).toBe(false);
    expect(config.DD_LLMOBS_AGENTLESS_ENABLED).toBe(false);
    expect(config.DD_SITE).toBe("datadoghq.com");
    expect(config.DD_SERVICE).toBe("qasey");
    expect(config.SLACK_CHANNEL_MODE).toBe("auto");
    expect(config.QASEY_SANDBOX_ENDPOINT_TEMPLATE).toBeUndefined();
    expect(config.QASEY_DEV_RUNTIME_ID).toBeUndefined();
    expect(config.QASEY_INSTANCE_ID).toBeUndefined();
    expect(config.QASEY_DEPLOYMENT_ID).toBeUndefined();
    expect(config.QASEY_TENANCY_MODE).toBe("single");
    expect(config.QASEY_SINGLE_TENANT_ID).toBeUndefined();
    expect(config.QASEY_PASSWORD_AUTH_ENABLED).toBe(true);
    expect(config.QASEY_PASSWORD_REGISTRATION_ENABLED).toBe(true);
    expect(config.QASEY_ADDITIONAL_TRUSTED_ORIGINS).toBeUndefined();
  });

  it("accepts only canonical exact additional browser origins", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      QASEY_ADDITIONAL_TRUSTED_ORIGINS: "http://qasey:4111, https://e2e.example.test",
    } as NodeJS.ProcessEnv).QASEY_ADDITIONAL_TRUSTED_ORIGINS).toEqual([
      "http://qasey:4111",
      "https://e2e.example.test",
    ]);
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_ADDITIONAL_TRUSTED_ORIGINS: "https://e2e.example.test/path",
    } as NodeJS.ProcessEnv)).toThrow(/canonical HTTP\(S\) origins/u);
  });

  it("limits each production Sandbox replica to one untrusted session", () => {
    expect(loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
    } as NodeJS.ProcessEnv).QASEY_SANDBOX_MAX_SESSIONS).toBe(1);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_SANDBOX_MAX_SESSIONS: "2",
    } as NodeJS.ProcessEnv)).toThrow(/QASEY_SANDBOX_MAX_SESSIONS.*exactly 1/iu);
  });

  it("rejects a subject traffic budget that exceeds its tenant budget", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_STANDARD_TENANT_REQUESTS_PER_MINUTE: "10",
      QASEY_STANDARD_SUBJECT_REQUESTS_PER_MINUTE: "11",
    } as NodeJS.ProcessEnv)).toThrow(/subject request limit/iu);
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_EXPENSIVE_TENANT_REQUESTS_PER_MINUTE: "2",
      QASEY_EXPENSIVE_SUBJECT_REQUESTS_PER_MINUTE: "3",
    } as NodeJS.ProcessEnv)).toThrow(/expensive subject/iu);
  });

  it("accepts model cost rates only as a complete pair", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN: "1.25",
    } as NodeJS.ProcessEnv)).toThrow(/both model input and output cost rates/iu);
    expect(loadConfig({
      NODE_ENV: "test",
      QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN: "1.25",
      QASEY_MODEL_OUTPUT_COST_MICROUSD_PER_TOKEN: "10",
    } as NodeJS.ProcessEnv)).toMatchObject({
      QASEY_MODEL_INPUT_COST_MICROUSD_PER_TOKEN: 1.25,
      QASEY_MODEL_OUTPUT_COST_MICROUSD_PER_TOKEN: 10,
    });
  });

  it("uses an explicit portable instance ID instead of a deployment namespace convention", () => {
    expect(loadConfig({ NODE_ENV: "test", QASEY_INSTANCE_ID: "community-preview_1" } as NodeJS.ProcessEnv).QASEY_INSTANCE_ID)
      .toBe("community-preview_1");
    expect(() => loadConfig({ NODE_ENV: "test", QASEY_INSTANCE_ID: "private/environment" } as NodeJS.ProcessEnv))
      .toThrow(/QASEY_INSTANCE_ID/u);
  });

  it("uses explicit production tenant ownership and rejects global connections in multi-tenant mode", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_SINGLE_TENANT_ID: undefined,
    } as NodeJS.ProcessEnv)).toThrow(/QASEY_SINGLE_TENANT_ID/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      GOOGLE_ALLOWED_DOMAINS: undefined,
    } as NodeJS.ProcessEnv)).toThrow(/GOOGLE_ALLOWED_DOMAINS/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_TENANCY_MODE: "multi",
      QASEY_SINGLE_TENANT_ID: undefined,
      SLACK_BOT_TOKEN: "redacted-global-slack-credential",
    } as NodeJS.ProcessEnv)).toThrow(/not allowed in multi-tenant mode/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_TENANCY_MODE: "multi",
      QASEY_SINGLE_TENANT_ID: undefined,
      GITHUB_TOKEN: "synthetic-personal-access-token-at-least-32-bytes",
    } as NodeJS.ProcessEnv)).toThrow(/GITHUB_TOKEN is a process-global connection/u);
    expect(loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_TENANCY_MODE: "multi",
      QASEY_SINGLE_TENANT_ID: undefined,
    } as NodeJS.ProcessEnv).QASEY_TENANCY_MODE).toBe("multi");
  });

  it("builds a versioned credential keyring while preserving the legacy default key", () => {
    const legacy = loadConfig({
      NODE_ENV: "test",
      QASEY_CREDENTIAL_ENCRYPTION_KEY: "legacy-credential-encryption-key-over-32-bytes",
    } as NodeJS.ProcessEnv);
    expect(resolveCredentialKeyring(legacy)).toEqual({
      activeKeyId: "default",
      keys: { default: "legacy-credential-encryption-key-over-32-bytes" },
    });

    const versioned = loadConfig({
      NODE_ENV: "test",
      QASEY_CREDENTIAL_ACTIVE_KEY_ID: "key-2026-09",
      QASEY_CREDENTIAL_ENCRYPTION_KEY: "new-credential-encryption-key-over-32-bytes",
      QASEY_CREDENTIAL_PREVIOUS_KEYS: JSON.stringify({
        default: "legacy-credential-encryption-key-over-32-bytes",
        "key-2026-08": "previous-credential-encryption-key-over-32-bytes",
      }),
    } as NodeJS.ProcessEnv);
    expect(resolveCredentialKeyring(versioned)).toEqual({
      activeKeyId: "key-2026-09",
      keys: {
        default: "legacy-credential-encryption-key-over-32-bytes",
        "key-2026-08": "previous-credential-encryption-key-over-32-bytes",
        "key-2026-09": "new-credential-encryption-key-over-32-bytes",
      },
    });
  });

  it("rejects ambiguous credential keyrings without reflecting key material", () => {
    const secret = "redacted-previous-credential-key-over-32-bytes";
    for (const previous of [
      "not-json",
      JSON.stringify({ next: "too-short" }),
      JSON.stringify({ active: secret }),
      JSON.stringify({ previous: secret }),
    ]) {
      const activeKey = previous.includes("previous") ? secret : "active-credential-encryption-key-over-32-bytes";
      let message = "";
      try {
        loadConfig({
          NODE_ENV: "test",
          QASEY_CREDENTIAL_ACTIVE_KEY_ID: "active",
          QASEY_CREDENTIAL_ENCRYPTION_KEY: activeKey,
          QASEY_CREDENTIAL_PREVIOUS_KEYS: previous,
        } as NodeJS.ProcessEnv);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });

  it("builds and validates an independently versioned MCP OAuth keyring", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MASTRA_ENCRYPTION_ACTIVE_KEY_ID: "oauth-2026-09",
      MASTRA_ENCRYPTION_KEY: "active-oauth-encryption-key-over-32-bytes",
      MASTRA_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({
        default: "legacy-oauth-encryption-key-over-32-bytes",
      }),
    } as NodeJS.ProcessEnv);
    expect(resolveMcpOAuthKeyring(config)).toEqual({
      activeKeyId: "oauth-2026-09",
      keys: {
        default: "legacy-oauth-encryption-key-over-32-bytes",
        "oauth-2026-09": "active-oauth-encryption-key-over-32-bytes",
      },
    });

    expect(() => loadConfig({
      NODE_ENV: "test",
      MASTRA_ENCRYPTION_ACTIVE_KEY_ID: "active",
      MASTRA_ENCRYPTION_KEY: "active-oauth-encryption-key-over-32-bytes",
      MASTRA_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({
        active: "previous-oauth-encryption-key-over-32-bytes",
      }),
    } as NodeJS.ProcessEnv)).toThrow(/must not redefine/iu);
  });

  it("uses Sandbox endpoint presence as capability configuration", () => {
    expect(loadConfig({
      NODE_ENV: "development",
      QASEY_SANDBOX_ENDPOINT_TEMPLATE: "http://127.0.0.1:412{ordinal}",
      QASEY_SANDBOX_CONTROL_KEY: productionAuth.QASEY_SANDBOX_CONTROL_KEY,
      QASEY_SANDBOX_LEASE_KEY: productionAuth.QASEY_SANDBOX_LEASE_KEY,
    } as NodeJS.ProcessEnv).QASEY_SANDBOX_ENDPOINT_TEMPLATE).toBe("http://127.0.0.1:412{ordinal}");
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_SANDBOX_ENDPOINT_TEMPLATE: "http://127.0.0.1:4120",
      QASEY_SANDBOX_CONTROL_KEY: productionAuth.QASEY_SANDBOX_CONTROL_KEY,
      QASEY_SANDBOX_LEASE_KEY: productionAuth.QASEY_SANDBOX_LEASE_KEY,
    } as NodeJS.ProcessEnv)).toThrow(/must contain \{ordinal\}/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_SANDBOX_ENDPOINT_TEMPLATE: undefined,
    } as NodeJS.ProcessEnv)).toThrow(/required in production/);
  });

  it("requires separated Sandbox control and lease keys and HTTPS in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_SANDBOX_ENDPOINT_TEMPLATE: "http://127.0.0.1:412{ordinal}",
    } as NodeJS.ProcessEnv)).toThrow(/QASEY_SANDBOX_CONTROL_KEY/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_SANDBOX_ENDPOINT_TEMPLATE: "http://sandbox-{ordinal}.example.com",
    } as NodeJS.ProcessEnv)).toThrow(/must use HTTPS/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_SANDBOX_LEASE_KEY: productionAuth.QASEY_SANDBOX_CONTROL_KEY,
    } as NodeJS.ProcessEnv)).toThrow(/must be distinct/);
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_SANDBOX_ENDPOINT_TEMPLATE: "http://127.0.0.1:412{ordinal}",
      QASEY_SANDBOX_CONTROL_KEY: "too-short",
      QASEY_SANDBOX_LEASE_KEY: productionAuth.QASEY_SANDBOX_LEASE_KEY,
    } as NodeJS.ProcessEnv)).toThrow(/32 UTF-8 bytes/);
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

  it("requires shared encrypted artifact storage in distributed production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_ARTIFACT_STORE: "local",
    } as NodeJS.ProcessEnv)).toThrow(/requires QASEY_ARTIFACT_STORE=s3/);
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_ARTIFACT_STORE: "s3",
    } as NodeJS.ProcessEnv)).toThrow(/QASEY_ARTIFACT_S3_BUCKET/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_ARTIFACT_S3_ENDPOINT: "http://minio.example.com",
    } as NodeJS.ProcessEnv)).toThrow(/must use HTTPS/);
  });

  it("supports a standalone production service backed by one PostgreSQL URL", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      QASEY_DEPLOYMENT_MODE: "standalone",
      QASEY_INSTANCE_ID: "production-standalone",
      QASEY_DEPLOYMENT_ID: "production",
      DD_VERSION: "sha256-release-a",
      DATABASE_URL: "postgresql://postgres.example/qasey",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      GOOGLE_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
      GOOGLE_ALLOWED_DOMAINS: "example.com",
      QASEY_SINGLE_TENANT_ID: "example",
      QASEY_CREDENTIAL_ENCRYPTION_KEY: "connection-credential-key-over-32-bytes",
    } as NodeJS.ProcessEnv);

    expect(config.OBSERVABILITY_DATABASE_URL).toBe(config.DATABASE_URL);
    expect(resolveRedisDurabilityEnabled(config)).toBe(false);
    expect(config.WORKER_TOKEN).toBeUndefined();
    expect(config.QASEY_SANDBOX_ENDPOINT_TEMPLATE).toBeUndefined();
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
    expect(resolveSlackChannelMode({ NODE_ENV: "development", ...credentials, QASEY_DEV_TUNNEL_ENABLED: true })).toBeUndefined();
  });

  it("enables the Dev Runtime tunnel for configured local clients and production servers", () => {
    const token = "dev-tunnel-token-with-at-least-32-bytes";
    const local = loadConfig({
      NODE_ENV: "development",
      QASEY_DEV_TUNNEL_ENABLED: "true",
      QASEY_DEV_TUNNEL_BASE_URL: "https://qasey.example.com",
      QASEY_DEV_TUNNEL_TOKEN: token,
    } as NodeJS.ProcessEnv);
    expect(devRuntimeTunnelClientEnabled(local)).toBe(true);
    expect(devRuntimeTunnelServerEnabled(local)).toBe(false);

    const testing = loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_DEV_TUNNEL_ENABLED: "true",
      QASEY_DEV_TUNNEL_TOKEN: token,
    } as NodeJS.ProcessEnv);
    expect(devRuntimeTunnelServerEnabled(testing)).toBe(true);
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_DEV_TUNNEL_ENABLED: "true",
      QASEY_DEV_TUNNEL_BASE_URL: "https://qasey.example.com",
      QASEY_DEV_TUNNEL_TOKEN: "too-short",
    } as NodeJS.ProcessEnv)).toThrow(/32 UTF-8 bytes/u);
  });

  it("accepts an explicit stable local runtime identity", () => {
    expect(loadConfig({
      NODE_ENV: "development",
      QASEY_DEV_RUNTIME_ID: "local-ABCDEFG2",
    } as NodeJS.ProcessEnv).QASEY_DEV_RUNTIME_ID).toBe("local-ABCDEFG2");
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_DEV_RUNTIME_ID: "local-invalid",
    } as NodeJS.ProcessEnv)).toThrow(/QASEY_DEV_RUNTIME_ID/);
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

  it("requires an API key only for agentless Datadog runtimes", () => {
    expect(() => loadConfig({
      NODE_ENV: "development",
      QASEY_ENABLE_DATADOG: "true",
      DD_LLMOBS_ML_APP: "qasey",
      DD_LLMOBS_AGENTLESS_ENABLED: "true",
    } as NodeJS.ProcessEnv)).toThrow(/DD_API_KEY/);

    const config = loadConfig({
      NODE_ENV: "development",
      QASEY_ENABLE_DATADOG: "true",
      DD_LLMOBS_ML_APP: "qasey",
      DD_LLMOBS_AGENTLESS_ENABLED: "true",
      DD_API_KEY: "test-api-key",
      DD_SITE: "us5.datadoghq.com",
    } as NodeJS.ProcessEnv);
    expect(config.DD_LLMOBS_AGENTLESS_ENABLED).toBe(true);
    expect(config.DD_SITE).toBe("us5.datadoghq.com");
  });

  it("rejects Studio Editor configuration while parsing the remaining Studio switches", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_ENABLE_STUDIO_EDITOR: "true",
      OBSERVABILITY_DATABASE_URL: "postgresql://observability.example/qasey_observability",
    } as NodeJS.ProcessEnv)).toThrow(/does not include Mastra Studio Editor/);
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      EDITOR_DATABASE_URL: "postgresql://editor.example/qasey_editor",
      OBSERVABILITY_DATABASE_URL: "postgresql://observability.example/qasey_observability",
    } as NodeJS.ProcessEnv)).toThrow(/does not include Mastra Studio Editor/);

    const config = loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_ENABLE_STUDIO_MCP_PREVIEW: "false",
      OBSERVABILITY_DATABASE_URL: "postgresql://observability.example/qasey_observability",
    } as NodeJS.ProcessEnv);

    expect(config.QASEY_ENABLE_STUDIO_MCP_PREVIEW).toBe(false);
    expect(config.OBSERVABILITY_DATABASE_URL).toContain("qasey_observability");
  });

  it("accepts a GitHub personal access token and rejects short credentials", () => {
    expect(() => loadConfig({ GITHUB_TOKEN: "too-short" } as NodeJS.ProcessEnv)).toThrow(/GitHub token/u);
    const config = loadConfig({
      GITHUB_TOKEN: "synthetic-personal-access-token-at-least-32-bytes",
    } as NodeJS.ProcessEnv);
    expect(config.GITHUB_TOKEN).toBe("synthetic-personal-access-token-at-least-32-bytes");
  });

  it("enables single-tenant password login and registration by default in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_COOKIE_PASSWORD: "short",
    } as NodeJS.ProcessEnv)).toThrow();

    const passwordOnly = loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_COOKIE_PASSWORD: undefined,
      GOOGLE_ALLOWED_DOMAINS: undefined,
      QASEY_PASSWORD_AUTH_ENABLED: undefined,
      QASEY_PASSWORD_REGISTRATION_ENABLED: undefined,
    } as NodeJS.ProcessEnv);
    expect(passwordOnly).toMatchObject({
      QASEY_PASSWORD_AUTH_ENABLED: true,
      QASEY_PASSWORD_REGISTRATION_ENABLED: true,
    });
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_COOKIE_PASSWORD: undefined,
      GOOGLE_ALLOWED_DOMAINS: undefined,
      QASEY_PASSWORD_AUTH_ENABLED: "false",
    } as NodeJS.ProcessEnv)).toThrow(/requires Google login or QASEY_PASSWORD_AUTH_ENABLED=true/);
    expect(loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      QASEY_PASSWORD_AUTH_ENABLED: "false",
      QASEY_PASSWORD_REGISTRATION_ENABLED: "false",
    } as NodeJS.ProcessEnv)).toMatchObject({
      QASEY_PASSWORD_AUTH_ENABLED: false,
      QASEY_PASSWORD_REGISTRATION_ENABLED: false,
    });
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      PLATFORM_LOCAL_ADMIN_EMAILS: "owner@example.invalid",
    } as NodeJS.ProcessEnv)).toThrow(/development-only/iu);
    expect(loadConfig({
      NODE_ENV: "test",
      QASEY_TENANCY_MODE: "multi",
    } as NodeJS.ProcessEnv)).toMatchObject({
      QASEY_PASSWORD_AUTH_ENABLED: false,
      QASEY_PASSWORD_REGISTRATION_ENABLED: false,
    });
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_TENANCY_MODE: "multi",
      QASEY_PASSWORD_AUTH_ENABLED: "true",
    } as NodeJS.ProcessEnv)).toThrow(/single-tenant installations/iu);
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_PASSWORD_AUTH_ENABLED: "false",
      QASEY_PASSWORD_REGISTRATION_ENABLED: "true",
    } as NodeJS.ProcessEnv)).toThrow(/registration requires/iu);
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
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      WORKER_TOKEN: "too-short",
    } as NodeJS.ProcessEnv)).toThrow(/32 UTF-8 bytes/u);
  });

  it.each(["WORKER_TOKEN", "PLATFORM_SERVICE_TOKEN", "QASEY_DEV_TUNNEL_TOKEN", "JIRA_WEBHOOK_TOKEN"] as const)(
    "rejects weak %s bearer credentials before startup",
    key => {
      expect(() => loadConfig({ NODE_ENV: "test", [key]: "too-short" } as NodeJS.ProcessEnv))
        .toThrow(/32 UTF-8 bytes/u);
    },
  );

  it("validates the orchestration Worker's authenticated step-execution endpoint", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      MASTRA_WORKERS: "orchestration",
      WORKER_TOKEN: "worker-token-with-at-least-32-random-bytes",
    } as NodeJS.ProcessEnv)).toThrow(/MASTRA_STEP_EXECUTION_URL/);
    expect(() => loadConfig({
      NODE_ENV: "test",
      MASTRA_WORKERS: "orchestration",
      MASTRA_STEP_EXECUTION_URL: "http://api.example.com",
      WORKER_TOKEN: "worker-token-with-at-least-32-random-bytes",
    } as NodeJS.ProcessEnv)).toThrow(/local HTTP/);

    const localWorker = loadConfig({
      NODE_ENV: "test",
      MASTRA_WORKERS: "orchestration",
      MASTRA_STEP_EXECUTION_URL: "http://127.0.0.1:4111/api",
      WORKER_TOKEN: "worker-token-with-at-least-32-random-bytes",
    } as NodeJS.ProcessEnv);
    expect(localWorker.MASTRA_STEP_EXECUTION_URL).toBe("http://127.0.0.1:4111/api");

    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      MASTRA_WORKERS: "orchestration",
      MASTRA_STEP_EXECUTION_URL: "http://127.0.0.1:4111/api",
    } as NodeJS.ProcessEnv)).toThrow(/must use HTTPS/);
    expect(loadConfig({
      NODE_ENV: "production",
      ...productionAuth,
      MASTRA_WORKERS: "orchestration",
      MASTRA_STEP_EXECUTION_URL: "https://qasey.example.com/api",
    } as NodeJS.ProcessEnv).MASTRA_WORKERS).toBe("orchestration");
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
