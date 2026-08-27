import { Octokit } from "@octokit/rest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubClient,
  GitHubInstallationTokenProvider,
  GitHubPublisher,
  loadConfig,
  normalizeGitHubPrivateKey,
  stableGitHubPullRequestKey,
} from "../../packages/adapters/src/index.ts";

const testPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const repository = {
  owner: "example-org",
  repository: "web-e2e",
  cloneUrl: "https://github.com/example-org/web-e2e.git",
  baseRef: "main",
  allowedPaths: ["tests"],
  skillsPaths: [],
};

function openPullRequest(number = 1) {
  return {
    number,
    state: "open",
    html_url: `https://github.com/example-org/web-e2e/pull/${number}`,
    body: "repair",
    head: { ref: "qasey/run-1", repo: { full_name: "example-org/web-e2e" } },
    base: { ref: "main" },
  };
}

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
      expect(normalized.startsWith(["-----BEGIN RSA ", "PRIVATE KEY-----\n"].join(""))).toBe(true);
      expect(normalized.endsWith(["\n-----END RSA ", "PRIVATE KEY-----\n"].join(""))).toBe(true);
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
      token: "synthetic-installation-token-0000000000",
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

    await expect(provider.readToken()).resolves.toBe("synthetic-installation-token-0000000000");
    await expect(provider.readToken()).resolves.toBe("synthetic-installation-token-0000000000");
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({
      type: "installation",
      permissions: { contents: "read", pull_requests: "read" },
    });
  });

  it("updates the existing run branch and reuses its Draft PR during QA repair", async () => {
    const existingPull = openPullRequest();
    const octokit = {
      repos: { getCommit: vi.fn(async () => ({ data: { commit: { tree: { sha: "base-tree" } } } })) },
      git: {
        createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
        createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
        createCommit: vi.fn(async () => ({ data: { sha: "commit" } })),
        createRef: vi.fn(async () => { throw Object.assign(new Error("Reference already exists"), { status: 422 }); }),
        updateRef: vi.fn(async () => ({ data: {} })),
      },
      pulls: {
        list: vi.fn(async () => ({ data: [existingPull] })),
        create: vi.fn(),
      },
    };
    const publisher = new GitHubPublisher(octokit as never);

    await expect(publisher.publishChanges({
      repository,
      baseSha: "a".repeat(40), branch: "qasey/run-1", title: "repair", body: "repair",
      changes: [{ path: "tests/a.spec.ts", deleted: false, mode: "100644", content: Buffer.from("test") }],
      existingPullRequestUrl: "https://github.com/example-org/web-e2e/pull/1",
    })).resolves.toBe("https://github.com/example-org/web-e2e/pull/1");
    expect(octokit.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/qasey/run-1", sha: "commit", force: true }));
    expect(octokit.pulls.list).toHaveBeenCalledWith({
      owner: "example-org",
      repo: "web-e2e",
      state: "open",
      head: "example-org:qasey/run-1",
      base: "main",
      per_page: 100,
    });
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });

  it("reuses the open PR on a replay after GitHub accepted the original create", async () => {
    let remotePull: ReturnType<typeof openPullRequest> | undefined;
    const octokit = {
      pulls: {
        list: vi.fn(async () => ({ data: remotePull ? [remotePull] : [] })),
        create: vi.fn(async (input: { body: string }) => {
          remotePull = { ...openPullRequest(7), body: input.body };
          return { data: remotePull };
        }),
      },
    };
    const request = { repository, branch: "qasey/run-1", title: "repair", body: "repair" };

    await expect(new GitHubPublisher(octokit as never).createDraftPullRequest(request))
      .resolves.toBe("https://github.com/example-org/web-e2e/pull/7");
    await expect(new GitHubPublisher(octokit as never).createDraftPullRequest(request))
      .resolves.toBe("https://github.com/example-org/web-e2e/pull/7");

    expect(octokit.pulls.create).toHaveBeenCalledTimes(1);
    expect(octokit.pulls.create).toHaveBeenCalledWith(expect.objectContaining({
      owner: "example-org",
      repo: "web-e2e",
      head: "qasey/run-1",
      base: "main",
      body: expect.stringContaining(stableGitHubPullRequestKey(repository, "qasey/run-1")),
    }));
  });

  it("reconciles a 422 create race by querying the exact open PR", async () => {
    const pull = openPullRequest(8);
    const octokit = {
      pulls: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [] })
          .mockResolvedValueOnce({ data: [pull] }),
        create: vi.fn(async () => { throw Object.assign(new Error("validation failed"), { status: 422 }); }),
      },
    };

    await expect(new GitHubPublisher(octokit as never).createDraftPullRequest({
      repository, branch: "qasey/run-1", title: "repair", body: "repair",
    })).resolves.toBe("https://github.com/example-org/web-e2e/pull/8");
    expect(octokit.pulls.create).toHaveBeenCalledTimes(1);
    expect(octokit.pulls.list).toHaveBeenCalledTimes(2);
  });

  it("reports an ambiguous create outcome with a safe typed error", async () => {
    const leakedToken = "synthetic-auth-material-that-must-not-escape";
    const octokit = {
      pulls: {
        list: vi.fn()
          .mockResolvedValueOnce({ data: [] })
          .mockRejectedValueOnce(new Error(`Authorization: Bearer ${leakedToken}`)),
        create: vi.fn(async () => { throw new Error(`socket closed; token=${leakedToken}`); }),
      },
    };

    const error = await new GitHubPublisher(octokit as never).createDraftPullRequest({
      repository, branch: "qasey/run-1", title: "repair", body: "repair",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "side_effect_outcome_unknown",
      message: "GitHub pull request creation outcome requires operator reconciliation",
    });
    expect(String(error)).not.toContain(leakedToken);
    expect(JSON.stringify(error)).not.toContain(leakedToken);
  });
});
