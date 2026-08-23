import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { createGitHubClient, GitHubInstallationTokenProvider, loadConfig } from "../../packages/adapters/src/index.ts";

describe("GitHub App authentication", () => {
  it("creates an installation-authenticated Octokit only from complete app configuration", () => {
    expect(createGitHubClient(loadConfig({} as NodeJS.ProcessEnv))).toBeUndefined();
    expect(createGitHubClient(loadConfig({
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    } as NodeJS.ProcessEnv))).toBeInstanceOf(Octokit);
  });

  it("mints and caches an explicitly read-only installation token", async () => {
    const authenticate = vi.fn(async () => ({
      type: "token",
      tokenType: "installation",
      token: "ghs_test_read_only_token_12345678901234567890",
      installationId: 456,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      repositorySelection: "all",
      permissions: { contents: "read", pull_requests: "read" },
    }));
    const provider = new GitHubInstallationTokenProvider({
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: 456,
      GITHUB_APP_PRIVATE_KEY: "private-key",
    }, authenticate as never);

    await expect(provider.readToken()).resolves.toMatch(/^ghs_/u);
    await expect(provider.readToken()).resolves.toMatch(/^ghs_/u);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({
      type: "installation",
      permissions: { contents: "read", pull_requests: "read" },
    });
  });
});
