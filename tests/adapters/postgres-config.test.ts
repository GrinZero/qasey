import { describe, expect, it } from "vitest";
import { databaseUrlsFromPgParts, loadConfig } from "../../packages/adapters/src/config.ts";

const splitPostgresEnv = {
  PG_URL: "postgres.testing.example.com",
  PG_PORT: "5432",
  PG_QASEY_USER_NAME: "qasey-user",
  PG_QASEY_PASSWORD: "password/with:special@chars",
};

describe("split PostgreSQL configuration", () => {
  it("derives application and observability URLs on the same instance", () => {
    expect(databaseUrlsFromPgParts(splitPostgresEnv)).toEqual({
      application: "postgresql://qasey-user:password%2Fwith%3Aspecial%40chars@postgres.testing.example.com:5432/qasey",
      observability: "postgresql://qasey-user:password%2Fwith%3Aspecial%40chars@postgres.testing.example.com:5432/qasey_observability",
    });
  });

  it("lets direct local URLs override split deployment values", () => {
    const config = loadConfig({
      ...splitPostgresEnv,
      DATABASE_URL: "postgresql://localhost/direct",
      OBSERVABILITY_DATABASE_URL: "postgresql://localhost/direct_observability",
    });
    expect(config.DATABASE_URL).toBe("postgresql://localhost/direct");
    expect(config.OBSERVABILITY_DATABASE_URL).toBe("postgresql://localhost/direct_observability");
  });

  it("satisfies production storage requirements from split values", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      QASEY_DEPLOYMENT_MODE: "distributed",
      QASEY_INSTANCE_ID: "production-a",
      QASEY_DEPLOYMENT_ID: "production",
      DD_VERSION: "sha256-release-a",
      ...splitPostgresEnv,
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
      QASEY_ARTIFACT_STORE: "s3",
      QASEY_ARTIFACT_S3_BUCKET: "qasey-production-artifacts",
      QASEY_ARTIFACT_S3_REGION: "us-east-1",
      QASEY_SANDBOX_ENDPOINT_TEMPLATE: "https://qasey-sandbox-{ordinal}.example.com",
      QASEY_SANDBOX_CONTROL_KEY: "sandbox-control-key-with-32-bytes-minimum",
      QASEY_SANDBOX_LEASE_KEY: "sandbox-lease-key-that-is-separate-32-bytes",
    });
    expect(config.DATABASE_URL).toContain("/qasey");
    expect(config.OBSERVABILITY_DATABASE_URL).toContain("/qasey_observability");
  });

  it("keeps local observability on DuckDB unless a remote URL is explicit", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      ...splitPostgresEnv,
    });

    expect(config.DATABASE_URL).toContain("/qasey");
    expect(config.OBSERVABILITY_DATABASE_URL).toBeUndefined();
  });

  it("rejects incomplete split configuration", () => {
    expect(() => databaseUrlsFromPgParts({ PG_URL: "postgres.testing.example.com" })).toThrow(
      /PG_URL, PG_PORT, PG_QASEY_USER_NAME and PG_QASEY_PASSWORD/,
    );
  });

  it("ignores deployment-only split values before secrets are injected in tests", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PG_URL: "postgres.testing.example.com",
      PG_PORT: "5432",
      PG_QASEY_USER_NAME: "qasey-user",
    });
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.OBSERVABILITY_DATABASE_URL).toBeUndefined();
  });

  it.each(["development", "production"])("still rejects incomplete split configuration in %s", NODE_ENV => {
    expect(() => loadConfig({
      NODE_ENV,
      PG_URL: "postgres.testing.example.com",
      PG_PORT: "5432",
      PG_QASEY_USER_NAME: "qasey-user",
    })).toThrow(/PG_URL, PG_PORT, PG_QASEY_USER_NAME and PG_QASEY_PASSWORD/);
  });

});
