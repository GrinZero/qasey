import type { OwnerScope } from "../../../packages/contracts/src/index.ts";
import type { WebE2EConfiguration } from "../code-task/e2e-repository-skill.ts";
import type { BuildMetadata } from "./build-metadata.ts";

export type E2EPreflightCheckId = "sandbox" | "model" | "github" | "project_skill" | "auth_setup" | "playwright_config" | "authentication" | "version" | "test_environment";

export interface E2EPreflightCheck {
  id: E2EPreflightCheckId;
  status: "ready" | "blocked";
  message: string;
}

export interface E2EPreflightSnapshot {
  ready: boolean;
  checkedAt: string;
  repository: string;
  baseRef: string;
  baseSha?: string;
  environmentSourceSha: string;
  testEnvironment: { id: string; baseUrl: string };
  checks: E2EPreflightCheck[];
}

interface GitHubRepositoryReader {
  repos: {
    get(input: { owner: string; repo: string }): Promise<{ data: { permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } | null } }>;
    getCommit(input: { owner: string; repo: string; ref: string }): Promise<{ data: { sha: string } }>;
    getContent(input: { owner: string; repo: string; path: string; ref: string }): Promise<{ data: unknown }>;
  };
}

interface SandboxPreflightTarget {
  healthCheck(): Promise<void>;
  codeAgentHealthCheck(): Promise<void>;
  assertTestEnvironmentAddress(baseUrl: string): void;
}

export class E2EPreflightError extends Error {
  readonly code = "e2e_preflight_blocked";

  constructor(readonly snapshot: E2EPreflightSnapshot) {
    super(`E2E preflight blocked: ${snapshot.checks.filter(check => check.status === "blocked").map(check => `${check.id}: ${check.message}`).join("; ")}`);
    this.name = "E2EPreflightError";
  }
}

export class E2EPreflightService {
  constructor(private readonly dependencies: {
    buildMetadata: BuildMetadata;
    sandbox?: SandboxPreflightTarget;
    github?: GitHubRepositoryReader;
    fetch?: typeof fetch;
    environment?: Readonly<Record<string, string | undefined>>;
  }) {}

  async inspect(_owner: OwnerScope, configuration: WebE2EConfiguration): Promise<E2EPreflightSnapshot> {
    const checks: E2EPreflightCheck[] = [];
    const record = (id: E2EPreflightCheckId, status: E2EPreflightCheck["status"], message: string) => {
      checks.push({ id, status, message });
    };

    if (!this.dependencies.sandbox) {
      record("sandbox", "blocked", "Sandbox pool is not configured");
    } else {
      try {
        await this.dependencies.sandbox.healthCheck();
        this.dependencies.sandbox.assertTestEnvironmentAddress(configuration.environment.baseUrl);
        record("sandbox", "ready", "All replicas advertise native-mastra and the test address is routable");
      } catch (error) {
        record("sandbox", "blocked", message(error));
      }
    }

    if (!this.dependencies.sandbox) {
      record("model", "blocked", "Sandbox pool is not configured");
    } else {
      try {
        await this.dependencies.sandbox.codeAgentHealthCheck();
        record("model", "ready", "Every Sandbox replica has code agent credentials");
      } catch (error) {
        record("model", "blocked", message(error));
      }
    }

    let baseSha: string | undefined;
    if (!this.dependencies.github) {
      record("github", "blocked", "GitHub write client is not configured");
    } else {
      try {
        const [repository, commit] = await Promise.all([
          this.dependencies.github.repos.get({ owner: configuration.target.owner, repo: configuration.target.repository }),
          this.dependencies.github.repos.getCommit({
            owner: configuration.target.owner,
            repo: configuration.target.repository,
            ref: configuration.target.baseRef,
          }),
        ]);
        const permissions = repository.data.permissions;
        if (!permissions?.push && !permissions?.admin && !permissions?.maintain) {
          record("github", "blocked", "Configured GitHub identity cannot write the target repository");
        } else {
          record("github", "ready", "Target repository is readable and writable");
        }
        baseSha = commit.data.sha;
      } catch (error) {
        record("github", "blocked", message(error));
      }
    }

    if (!baseSha) {
      record("project_skill", "blocked", "Target base ref could not be resolved");
    } else if (!this.dependencies.github) {
      record("project_skill", "blocked", "GitHub read client is not configured");
    } else {
      try {
        const response = await this.dependencies.github.repos.getContent({
          owner: configuration.target.owner,
          repo: configuration.target.repository,
          path: configuration.target.e2eSkillPath,
          ref: baseSha,
        });
        if (!repositoryFile(response.data)) {
          throw new Error("Configured path is not a repository file");
        }
        record("project_skill", "ready", `Repository E2E Skill is pinned at ${configuration.target.e2eSkillPath}`);
      } catch (error) {
        record("project_skill", "blocked", `Repository E2E Skill ${configuration.target.e2eSkillPath} is unavailable: ${message(error)}`);
      }
    }

    if (!baseSha) {
      record("auth_setup", "blocked", "Target base ref could not be resolved");
    } else if (!this.dependencies.github) {
      record("auth_setup", "blocked", "GitHub read client is not configured");
    } else {
      try {
        const response = await this.dependencies.github.repos.getContent({
          owner: configuration.target.owner,
          repo: configuration.target.repository,
          path: configuration.target.e2eAuthentication.setupPath,
          ref: baseSha,
        });
        const setup = repositoryTextFile(response.data);
        assertAuthenticationSetupContract(setup, configuration);
        record("auth_setup", "ready", `Repository Playwright authentication setup is pinned at ${configuration.target.e2eAuthentication.setupPath}`);
      } catch (error) {
        record("auth_setup", "blocked", `Repository Playwright authentication setup ${configuration.target.e2eAuthentication.setupPath} is unavailable: ${message(error)}`);
      }
    }

    if (!baseSha) {
      record("playwright_config", "blocked", "Target base ref could not be resolved");
    } else if (!this.dependencies.github) {
      record("playwright_config", "blocked", "GitHub read client is not configured");
    } else {
      try {
        for (const configPath of new Set(configuration.verification.projects.map(project => project.config))) {
          const response = await this.dependencies.github.repos.getContent({
            owner: configuration.target.owner,
            repo: configuration.target.repository,
            path: configPath,
            ref: baseSha,
          });
          assertPlaywrightConfigContract(repositoryTextFile(response.data), configuration, configPath);
        }
        record("playwright_config", "ready", "Repository Playwright configs connect browser projects to the authentication setup project");
      } catch (error) {
        record("playwright_config", "blocked", message(error));
      }
    }

    const authenticationEnvironment = this.dependencies.environment ?? process.env;
    const missingAuthenticationEnvironment = configuration.target.e2eAuthentication.requiredEnvironment
      .filter(name => !authenticationEnvironment[name]?.trim());
    if (missingAuthenticationEnvironment.length > 0) {
      record("authentication", "blocked", `Repository Playwright setup requires unavailable environment variables: ${missingAuthenticationEnvironment.join(", ")}`);
    } else {
      record("authentication", "ready", "Repository Playwright setup environment is available");
    }

    if (!baseSha) {
      record("version", "blocked", "Target base SHA could not be resolved");
    } else if (baseSha !== this.dependencies.buildMetadata.sourceSha) {
      record("version", "blocked", `Deployment ${this.dependencies.buildMetadata.sourceSha} does not match ${configuration.target.baseRef} at ${baseSha}`);
    } else {
      record("version", "ready", `Deployment and target base ref both resolve to ${baseSha}`);
    }

    try {
      const healthUrl = new URL("/healthz", configuration.environment.baseUrl);
      const response = await (this.dependencies.fetch ?? fetch)(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`Test environment health check returned ${response.status}`);
      record("test_environment", "ready", `${configuration.environment.id} is reachable at ${configuration.environment.baseUrl}`);
    } catch (error) {
      record("test_environment", "blocked", message(error));
    }

    return {
      ready: checks.every(check => check.status === "ready"),
      checkedAt: new Date().toISOString(),
      repository: `${configuration.target.owner}/${configuration.target.repository}`,
      baseRef: configuration.target.baseRef,
      ...(baseSha ? { baseSha } : {}),
      environmentSourceSha: this.dependencies.buildMetadata.sourceSha,
      testEnvironment: configuration.environment,
      checks,
    };
  }

  async assertReady(owner: OwnerScope, configuration: WebE2EConfiguration): Promise<E2EPreflightSnapshot & { baseSha: string }> {
    const snapshot = await this.inspect(owner, configuration);
    if (!snapshot.ready || !snapshot.baseSha) throw new E2EPreflightError(snapshot);
    return { ...snapshot, baseSha: snapshot.baseSha };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repositoryFile(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as { type?: unknown }).type === "file");
}

function repositoryTextFile(value: unknown): string {
  if (!repositoryFile(value)) throw new Error("Configured path is not a repository file");
  const file = value as { content?: unknown; encoding?: unknown };
  if (file.encoding !== "base64" || typeof file.content !== "string" || !file.content.trim()) {
    throw new Error("Repository workflow content is unavailable");
  }
  return Buffer.from(file.content.replaceAll("\n", ""), "base64").toString("utf8");
}

function assertAuthenticationSetupContract(setup: string, configuration: WebE2EConfiguration): void {
  if (!/\bstorageState\b/u.test(setup)) {
    throw new Error("Authentication setup must persist Playwright storageState");
  }
  for (const name of configuration.target.e2eAuthentication.requiredEnvironment) {
    if (!setup.includes(name)) {
      throw new Error(`Authentication setup must consume declared environment variable ${name}`);
    }
  }
}

function assertPlaywrightConfigContract(
  source: string,
  configuration: WebE2EConfiguration,
  configPath: string,
): void {
  const setupProject = configuration.target.e2eAuthentication.setupProject;
  if (!source.includes(setupProject)) {
    throw new Error(`Playwright config ${configPath} must declare authentication setup project ${setupProject}`);
  }
  if (!/\bdependencies\b/u.test(source)) {
    throw new Error(`Playwright config ${configPath} must make browser projects depend on authentication setup project ${setupProject}`);
  }
  if (!/\bstorageState\b/u.test(source)) {
    throw new Error(`Playwright config ${configPath} must load storageState produced by authentication setup project ${setupProject}`);
  }
}
