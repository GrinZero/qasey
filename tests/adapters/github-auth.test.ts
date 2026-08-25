import { Octokit } from "@octokit/rest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubClient, GitHubInstallationTokenProvider, GitHubPublisher, loadConfig, normalizeGitHubPrivateKey } from "../../packages/adapters/src/index.ts";

const testPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" }).toString();

describe("GitHub App authentication", () => {
  it("creates an installation-authenticated Octokit only from complete app configuration", () => {
    expect(createGitHubClient(loadConfig({} as NodeJS.ProcessEnv))).toBeUndefined();
    expect(createGitHubClient(loadConfig({
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: "private-key",
    } as NodeJS.ProcessEnv))).toBeInstanceOf(Octokit);
  });

  it("normalizes flattened and escaped-newline GitHub App PEM secrets", () => {
    const flattened = testPrivateKey.replace(/\r?\n/gu, "");
    const escaped = testPrivateKey.replace(/\r?\n/gu, "\\n");
    for (const privateKey of [testPrivateKey, flattened, escaped, `"${escaped}"`]) {
      const normalized = normalizeGitHubPrivateKey(privateKey);
      expect(() => createPrivateKey(normalized)).not.toThrow();
      expect(normalized).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/u);
      expect(normalized).toMatch(/\n-----END RSA PRIVATE KEY-----\n$/u);
    }
    expect(loadConfig({
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: flattened,
    } as NodeJS.ProcessEnv).GITHUB_APP_PRIVATE_KEY)
      .toBe(normalizeGitHubPrivateKey(testPrivateKey));
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

  it("updates the existing run branch and reuses its Draft PR during QA repair", async () => {
    const octokit = {
      repos: { getCommit: vi.fn(async () => ({ data: { commit: { tree: { sha: "base-tree" } } } })) },
      git: {
        createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
        createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
        createCommit: vi.fn(async () => ({ data: { sha: "commit" } })),
        createRef: vi.fn(async () => { throw Object.assign(new Error("Reference already exists"), { status: 422 }); }),
        updateRef: vi.fn(async () => ({ data: {} })),
      },
      pulls: { create: vi.fn() },
    };
    const publisher = new GitHubPublisher(octokit as never);

    await expect(publisher.publishChanges({
      repository: { owner: "MoeGolibrary", repository: "moego-e2e-autotest", cloneUrl: "https://github.com/MoeGolibrary/moego-e2e-autotest.git", baseRef: "main", allowedPaths: ["tests"], skillsPaths: [] },
      baseSha: "a".repeat(40), branch: "qasey/run-1", title: "repair", body: "repair",
      changes: [{ path: "tests/a.spec.ts", deleted: false, mode: "100644", content: Buffer.from("test") }],
      existingPullRequestUrl: "https://github.com/MoeGolibrary/moego-e2e-autotest/pull/1",
    })).resolves.toBe("https://github.com/MoeGolibrary/moego-e2e-autotest/pull/1");
    expect(octokit.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/qasey/run-1", sha: "commit", force: true }));
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });
});
