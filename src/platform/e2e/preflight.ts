import type { OwnerScope } from "../../../packages/contracts/src/index.ts";
import type { WebE2EConfiguration } from "../code-task/e2e-repository-skill.ts";
import type { BuildMetadata } from "./build-metadata.ts";

export type E2EPreflightCheckId = "sandbox" | "model" | "github" | "version" | "test_environment" | "fixture";

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
  };
}

interface SandboxPreflightTarget {
  healthCheck(): Promise<void>;
  codeAgentHealthCheck(): Promise<void>;
  assertTestEnvironmentAddress(baseUrl: string): void;
}

interface FixturePreflightTarget {
  healthCheck(): Promise<void>;
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
    fixture: FixturePreflightTarget;
    github?: GitHubRepositoryReader;
    fetch?: typeof fetch;
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

    try {
      await this.dependencies.fixture.healthCheck();
      record("fixture", "ready", "Persistent fixture leases are available");
    } catch (error) {
      record("fixture", "blocked", message(error));
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
