import { describe, expect, it, vi } from "vitest";
import { E2EPreflightError, E2EPreflightService } from "../../src/platform/e2e/preflight.ts";
import type { WebE2EConfiguration } from "../../src/platform/code-task/e2e-repository-skill.ts";

const sourceSha = "a".repeat(40);
const owner = { applicationId: "qasey", tenantId: "tenant-1" };
const setupSource = [
  "const email = process.env.E2E_LOGIN_EMAIL;",
  "const password = process.env.E2E_LOGIN_PASSWORD;",
  "await page.context().storageState({ path: 'test-results/auth.json' });",
].join("\n");
const setupFile = { type: "file", encoding: "base64", content: Buffer.from(setupSource).toString("base64") };
const playwrightConfigSource = [
  "use: { video: 'on' },",
  "projects: [",
  "  { name: 'setup', testMatch: /auth\\.setup\\.ts/ },",
  "  { name: 'chromium', dependencies: ['setup'], use: { storageState: 'test-results/auth.json' } },",
  "]",
].join("\n");
const playwrightConfigFile = { type: "file", encoding: "base64", content: Buffer.from(playwrightConfigSource).toString("base64") };
const configuration: WebE2EConfiguration = {
  target: {
    owner: "example",
    repository: "web",
    cloneUrl: "https://github.com/example/web.git",
    baseRef: "main",
    allowedPaths: ["tests/e2e"],
    skillsPaths: [],
    e2eSkillPath: ".agents/skills/e2e-testing/SKILL.md",
    e2eAuthentication: {
      strategy: "repository-playwright-setup",
      setupPath: "tests/e2e/auth.setup.ts",
      setupProject: "setup",
      requiredEnvironment: ["E2E_LOGIN_EMAIL", "E2E_LOGIN_PASSWORD"],
    },
  },
  environment: { id: "dogfood", baseUrl: "https://e2e.example.test" },
  verification: {
    strategy: "changed-project-playwright",
    projects: [{ id: "web", root: "tests/e2e", testRoot: "tests/e2e", config: "tests/e2e/playwright.config.ts", playwrightProject: "chromium" }],
  },
  automationPathPolicy: {
    projects: [{ id: "web", testRoot: "tests/e2e", testFileSuffixes: [".spec.ts"] }],
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
    environment: { E2E_LOGIN_EMAIL: "operator@example.test", E2E_LOGIN_PASSWORD: "redacted" },
    github: {
      repos: {
        get: vi.fn(async () => ({ data: { permissions: { push: true } } })),
        getCommit: vi.fn(async () => ({ data: { sha: sourceSha } })),
        getContent: vi.fn(async (input: { path: string }) => ({
          data: input.path === configuration.target.e2eAuthentication.setupPath
            ? setupFile
            : input.path === configuration.verification.projects[0]?.config ? playwrightConfigFile : { type: "file" },
        })),
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
      environment: {},
      fetch: vi.fn(async () => { throw new Error("environment unavailable"); }),
    }));
    const error = await service.assertReady(owner, configuration).catch(value => value);
    expect(error).toBeInstanceOf(E2EPreflightError);
    expect(error.snapshot.checks.filter((check: { status: string }) => check.status === "blocked").map((check: { id: string }) => check.id))
      .toEqual(["sandbox", "model", "github", "project_skill", "auth_setup", "playwright_config", "authentication", "version", "test_environment"]);
  });

  it("blocks a deployment whose generated source metadata differs from the base ref", async () => {
    const service = new E2EPreflightService(dependencies({
      buildMetadata: { schemaVersion: 1 as const, sourceSha: "b".repeat(40) },
    }));
    const snapshot = await service.inspect(owner, configuration);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.checks).toContainEqual(expect.objectContaining({ id: "version", status: "blocked" }));
  });

  it("blocks before run creation when the pinned repository project Skill is missing", async () => {
    const inputs: unknown[] = [];
    const service = new E2EPreflightService(dependencies({
      github: {
        repos: {
          get: vi.fn(async () => ({ data: { permissions: { push: true } } })),
          getCommit: vi.fn(async () => ({ data: { sha: sourceSha } })),
          getContent: vi.fn(async (input: { path: string }) => {
            inputs.push(input);
            if (input.path === configuration.target.e2eSkillPath) throw new Error("Not Found");
            return { data: input.path === configuration.target.e2eAuthentication.setupPath
              ? setupFile
              : input.path === configuration.verification.projects[0]?.config ? playwrightConfigFile : { type: "file" } };
          }),
        },
      },
    }));

    const snapshot = await service.inspect(owner, configuration);

    expect(snapshot.ready).toBe(false);
    expect(snapshot.checks).toContainEqual(expect.objectContaining({ id: "project_skill", status: "blocked" }));
    expect(inputs).toEqual([expect.objectContaining({
      path: configuration.target.e2eSkillPath,
      ref: sourceSha,
    }), expect.objectContaining({
      path: configuration.target.e2eAuthentication.setupPath,
      ref: sourceSha,
    }), expect.objectContaining({
      path: configuration.verification.projects[0]?.config,
      ref: sourceSha,
    })]);
  });

  it("blocks when the repository authentication secrets are unavailable", async () => {
    const service = new E2EPreflightService(dependencies({ environment: { E2E_LOGIN_EMAIL: "operator@example.test" } }));

    const snapshot = await service.inspect(owner, configuration);

    expect(snapshot.ready).toBe(false);
    expect(snapshot.checks).toContainEqual(expect.objectContaining({
      id: "authentication",
      status: "blocked",
      message: expect.stringContaining("E2E_LOGIN_PASSWORD"),
    }));
  });

  it("blocks configs that cannot retain evidence for a passing Case", async () => {
    const configWithoutReviewEvidence = playwrightConfigSource.replace("use: { video: 'on' },\n", "");
    const service = new E2EPreflightService(dependencies({
      github: {
        repos: {
          get: vi.fn(async () => ({ data: { permissions: { push: true } } })),
          getCommit: vi.fn(async () => ({ data: { sha: sourceSha } })),
          getContent: vi.fn(async (input: { path: string }) => ({
            data: input.path === configuration.target.e2eAuthentication.setupPath
              ? setupFile
              : input.path === configuration.verification.projects[0]?.config
                ? { type: "file", encoding: "base64", content: Buffer.from(configWithoutReviewEvidence).toString("base64") }
                : { type: "file" },
          })),
        },
      },
    }));

    const snapshot = await service.inspect(owner, configuration);

    expect(snapshot.ready).toBe(false);
    expect(snapshot.checks).toContainEqual(expect.objectContaining({
      id: "playwright_config",
      status: "blocked",
      message: expect.stringContaining("retain video or trace evidence"),
    }));
  });

});
