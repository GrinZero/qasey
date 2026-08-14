import { describe, expect, it } from "vitest";
import { loadConfig } from "../../packages/adapters/src/index.ts";

const productionAuth = {
  DATABASE_URL: "postgresql://qasey.example/qasey",
  MASTRA_LICENSE_KEY: "mastra-license",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
};

describe("worker lease configuration", () => {
  it("uses a heartbeat comfortably shorter than the job lease", () => {
    const config = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(config.QASEY_JOB_HEARTBEAT_MS).toBe(15_000);
    expect(config.QASEY_JOB_LEASE_MS).toBe(90_000);
    expect(config.QASEY_AGENT_TIMEOUT_MS).toBe(600_000);
    expect(config.QASEY_MEMORY_MODEL).toBe("gpt-5.4-mini");
    expect(config.QASEY_MEMORY_MESSAGE_TOKENS).toBe(30_000);
    expect(config.QASEY_MEMORY_OBSERVATION_TOKENS).toBe(40_000);
    expect(config.QASEY_MEMORY_INPUT_TOKEN_LIMIT).toBe(120_000);
    expect(config.QASEY_ENABLE_STUDIO_EDITOR).toBeUndefined();
    expect(config.QASEY_ENABLE_STUDIO_MCP_PREVIEW).toBeUndefined();
    expect(config.EDITOR_DATABASE_URL).toBeUndefined();
    expect(config.OBSERVABILITY_DATABASE_URL).toBeUndefined();
    expect(config.QASEY_ENABLE_DATADOG).toBe(false);
    expect(config.QASEY_DATADOG_CAPTURE_CONTENT).toBe(false);
    expect(config.DD_SERVICE).toBe("qasey");
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
      EDITOR_DATABASE_URL: "postgresql://editor.example/qasey_editor",
      OBSERVABILITY_DATABASE_URL: "postgresql://observability.example/qasey_observability",
    } as NodeJS.ProcessEnv);

    expect(config.QASEY_ENABLE_STUDIO_EDITOR).toBe(true);
    expect(config.QASEY_ENABLE_STUDIO_MCP_PREVIEW).toBe(false);
    expect(config.EDITOR_DATABASE_URL).toContain("qasey_editor");
    expect(config.OBSERVABILITY_DATABASE_URL).toContain("qasey_observability");
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

  it("rejects a heartbeat interval that cannot safely renew the lease", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      QASEY_JOB_HEARTBEAT_MS: "50000",
      QASEY_JOB_LEASE_MS: "90000",
    } as NodeJS.ProcessEnv)).toThrow(/less than half/);
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
