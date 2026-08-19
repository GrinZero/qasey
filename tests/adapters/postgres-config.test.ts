import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { databaseUrlsFromPgParts, loadConfig } from "../../packages/adapters/src/config.ts";

const splitPostgresEnv = {
  PG_URL: "postgres.testing.internal",
  PG_PORT: "5432",
  PG_QASEY_USER_NAME: "qasey-user",
  PG_QASEY_PASSWORD: "password/with:special@chars",
};

describe("split PostgreSQL configuration", () => {
  it("derives application and observability URLs on the same instance", () => {
    expect(databaseUrlsFromPgParts(splitPostgresEnv)).toEqual({
      application: "postgresql://qasey-user:password%2Fwith%3Aspecial%40chars@postgres.testing.internal:5432/moego_qasey",
      observability: "postgresql://qasey-user:password%2Fwith%3Aspecial%40chars@postgres.testing.internal:5432/moego_qasey_observability",
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
      ...splitPostgresEnv,
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      GOOGLE_COOKIE_PASSWORD: "a-secure-cookie-password-over-32-chars",
      WORKER_TOKEN: "dedicated-worker-token",
      REDIS_HOST: "redis.internal",
      REDIS_PORT: "6379",
      REDIS_PASSWORD: "redis-password",
      REDIS_TLS: "true",
    });
    expect(config.DATABASE_URL).toContain("/moego_qasey");
    expect(config.OBSERVABILITY_DATABASE_URL).toContain("/moego_qasey_observability");
  });

  it("rejects incomplete split configuration", () => {
    expect(() => databaseUrlsFromPgParts({ PG_URL: "postgres.testing.internal" })).toThrow(
      /PG_URL, PG_PORT, PG_QASEY_USER_NAME and PG_QASEY_PASSWORD/,
    );
  });

  it("ignores deployment-only split values before secrets are injected in tests", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PG_URL: "postgres.testing.internal",
      PG_PORT: "5432",
      PG_QASEY_USER_NAME: "qasey-user",
    });
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.OBSERVABILITY_DATABASE_URL).toBeUndefined();
  });

  it.each(["development", "production"])("still rejects incomplete split configuration in %s", NODE_ENV => {
    expect(() => loadConfig({
      NODE_ENV,
      PG_URL: "postgres.testing.internal",
      PG_PORT: "5432",
      PG_QASEY_USER_NAME: "qasey-user",
    })).toThrow(/PG_URL, PG_PORT, PG_QASEY_USER_NAME and PG_QASEY_PASSWORD/);
  });

  it("keeps only the environment-specific database passwords in AWS secrets", () => {
    const envJson = JSON.parse(
      readFileSync(new URL("../../ci/env.json", import.meta.url), "utf8"),
    ) as { env: Record<string, string>; environments: Record<string, Record<string, string>> };
    expect(envJson.environments.testing).toEqual({
      PG_QASEY_PASSWORD: "datasource.postgres.password",
    });
    expect(envJson.environments.devops).toEqual({
      PG_QASEY_PASSWORD: "datasource.postgres.moego_qasey.password",
    });
    expect(envJson.env).toMatchObject({
      WORKER_TOKEN: "qasey.mastra.worker.token",
      MASTRA_WORKER_AUTH_TOKEN: "qasey.mastra.worker.token",
      REDIS_HOST: "redis.host",
      REDIS_PORT: "redis.port",
      REDIS_PASSWORD: "redis.password",
      REDIS_TLS: "redis.tls",
    });

    for (const environment of ["testing", "devops"]) {
      const envFile = readFileSync(
        new URL(`../../.env.${environment}`, import.meta.url),
        "utf8",
      );
      expect(envFile).toMatch(/^PG_URL=\S+$/m);
      expect(envFile).toMatch(/^PG_PORT=\d+$/m);
      expect(envFile).toMatch(/^PG_QASEY_USER_NAME=\S+$/m);
      expect(envFile).not.toMatch(/^PG_QASEY_PASSWORD=/m);
      expect(envFile).not.toMatch(/^REDIS_PASSWORD=/m);
    }
  });
});
