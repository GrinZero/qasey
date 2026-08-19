import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { createGitHubClient, loadConfig } from "../../packages/adapters/src/index.ts";

describe("GitHub App authentication", () => {
  it("creates an installation-authenticated Octokit only from complete app configuration", () => {
    expect(createGitHubClient(loadConfig({} as NodeJS.ProcessEnv))).toBeUndefined();
    expect(createGitHubClient(loadConfig({
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    } as NodeJS.ProcessEnv))).toBeInstanceOf(Octokit);
  });
});
