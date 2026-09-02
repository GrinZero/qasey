import { describe, expect, it, vi } from "vitest";
import { E2EPreflightError, E2EPreflightService } from "../../src/platform/e2e/preflight.ts";
import type { WebE2EConfiguration } from "../../src/platform/code-task/e2e-repository-skill.ts";

const sourceSha = "a".repeat(40);
const owner = { applicationId: "qasey", tenantId: "tenant-1" };
const configuration: WebE2EConfiguration = {
  target: {
    owner: "example",
    repository: "web",
    cloneUrl: "https://github.com/example/web.git",
    baseRef: "main",
    allowedPaths: ["tests/e2e"],
    skillsPaths: [],
  },
  environment: { id: "dogfood", baseUrl: "https://e2e.example.test" },
  verification: {
    strategy: "changed-project-playwright",
    projects: [{ id: "web", root: "tests/e2e", testRoot: "tests/e2e", config: "tests/e2e/playwright.config.ts", playwrightProject: "chromium" }],
  },
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    buildMetadata: { schemaVersion: 1 as const, sourceSha },
    sandbox: {
      healthCheck: vi.fn(async () => undefined),
      codeAgentHealthCheck: vi.fn(async () => undefined),
      assertTestEnvironmentAddress: vi.fn(() => undefined),
    },
    fixture: { healthCheck: vi.fn(async () => undefined) },
    github: {
      repos: {
        get: vi.fn(async () => ({ data: { permissions: { push: true } } })),
        getCommit: vi.fn(async () => ({ data: { sha: sourceSha } })),
      },
    },
    fetch: vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    ...overrides,
  };
}

describe("E2E preflight", () => {
  it("returns a frozen base SHA only after every dependency is ready", async () => {
    const service = new E2EPreflightService(dependencies());
    await expect(service.assertReady(owner, configuration)).resolves.toMatchObject({
      ready: true,
      baseSha: sourceSha,
      environmentSourceSha: sourceSha,
      testEnvironment: configuration.environment,
    });
  });

  it("reports all blockers together and refuses to start", async () => {
    const service = new E2EPreflightService(dependencies({
      buildMetadata: { schemaVersion: 1 as const, sourceSha: "b".repeat(40) },
      sandbox: undefined,
      github: undefined,
      fixture: { healthCheck: vi.fn(async () => { throw new Error("fixture database unavailable"); }) },
      fetch: vi.fn(async () => { throw new Error("environment unavailable"); }),
    }));
    const error = await service.assertReady(owner, configuration).catch(value => value);
    expect(error).toBeInstanceOf(E2EPreflightError);
    expect(error.snapshot.checks.filter((check: { status: string }) => check.status === "blocked").map((check: { id: string }) => check.id))
      .toEqual(["sandbox", "model", "github", "version", "test_environment", "fixture"]);
  });

  it("blocks a deployment whose generated source metadata differs from the base ref", async () => {
    const service = new E2EPreflightService(dependencies({
      buildMetadata: { schemaVersion: 1 as const, sourceSha: "b".repeat(40) },
    }));
    const snapshot = await service.inspect(owner, configuration);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.checks).toContainEqual(expect.objectContaining({ id: "version", status: "blocked" }));
  });
});
