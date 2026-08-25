import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepositoryProfile } from "../../contracts/src/index.ts";
import { normalizeGitHubPrivateKey, type QaseyConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

type GitHubAppConfig = Pick<
  QaseyConfig,
  "GITHUB_APP_ID" | "GITHUB_APP_INSTALLATION_ID" | "GITHUB_APP_PRIVATE_KEY"
>;

export function createGitHubClient(config: GitHubAppConfig): Octokit | undefined {
  if (!config.GITHUB_APP_ID || !config.GITHUB_APP_INSTALLATION_ID || !config.GITHUB_APP_PRIVATE_KEY) return undefined;
  const privateKey = normalizeGitHubPrivateKey(config.GITHUB_APP_PRIVATE_KEY);
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.GITHUB_APP_ID,
      installationId: config.GITHUB_APP_INSTALLATION_ID,
      privateKey,
    },
  });
}

export class GitHubInstallationTokenProvider {
  private readonly authenticate: ReturnType<typeof createAppAuth>;
  private cached?: { token: string; expiresAt: number };

  constructor(config: GitHubAppConfig, authenticate?: ReturnType<typeof createAppAuth>) {
    if (!config.GITHUB_APP_ID || !config.GITHUB_APP_INSTALLATION_ID || !config.GITHUB_APP_PRIVATE_KEY) {
      throw new Error("GitHub App authentication is not configured");
    }
    const privateKey = normalizeGitHubPrivateKey(config.GITHUB_APP_PRIVATE_KEY);
    this.authenticate = authenticate ?? createAppAuth({
      appId: config.GITHUB_APP_ID,
      installationId: config.GITHUB_APP_INSTALLATION_ID,
      privateKey,
    });
  }

  async readToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 5 * 60_000) return this.cached.token;
    const authentication = await this.authenticate({
      type: "installation",
      permissions: {
        contents: "read",
        pull_requests: "read",
      },
    });
    if (!("token" in authentication) || typeof authentication.token !== "string") {
      throw new Error("GitHub App did not return an installation token");
    }
    const expiresAt = "expiresAt" in authentication && typeof authentication.expiresAt === "string"
      ? Date.parse(authentication.expiresAt)
      : Date.now() + 50 * 60_000;
    this.cached = { token: authentication.token, expiresAt };
    return authentication.token;
  }
}

export class GitHubPublisher {
  constructor(private readonly octokit?: Octokit) {}
  get configured(): boolean { return Boolean(this.octokit); }

  async publishWorkspace(input: {
    repository: RepositoryProfile;
    root: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<string> {
    const { stdout: baseOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.root });
    const baseSha = baseOutput.trim();
    const changes = await changedFiles(input.root, input.repository.allowedPaths);
    if (changes.length === 0) throw new Error("Refusing to publish an empty change");
    const materialized = await Promise.all(changes.map(async change => {
      if (change.deleted) {
        return { path: change.path, deleted: true as const };
      }
      const absolute = join(input.root, change.path);
      const stats = await lstat(absolute);
      const content = stats.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
      return { path: change.path, deleted: false as const, mode: stats.isSymbolicLink() ? "120000" as const : stats.mode & 0o111 ? "100755" as const : "100644" as const, content };
    }));
    return this.publishChanges({ ...input, baseSha, changes: materialized });
  }

  async publishChanges(input: {
    repository: RepositoryProfile;
    baseSha: string;
    branch: string;
    title: string;
    body: string;
    changes: Array<{ path: string; deleted: boolean; mode?: "100644" | "100755" | "120000"; content?: Buffer }>;
    existingPullRequestUrl?: string;
  }): Promise<string> {
    const octokit = this.requireClient();
    if (input.changes.length === 0) throw new Error("Refusing to publish an empty change");
    const tree: Array<{ path: string; mode: "100644" | "100755" | "120000"; type: "blob"; sha: string | null }> = [];
    for (const change of input.changes) {
      if (change.deleted) {
        tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      if (!change.content || !change.mode) throw new Error(`Published change ${change.path} is missing content or mode`);
      const blob = await octokit.git.createBlob({
        owner: input.repository.owner, repo: input.repository.repository,
        content: change.content.toString("base64"), encoding: "base64",
      });
      tree.push({ path: change.path, mode: change.mode, type: "blob", sha: blob.data.sha });
    }
    const baseCommit = await octokit.repos.getCommit({
      owner: input.repository.owner, repo: input.repository.repository, ref: input.baseSha,
    });
    const createdTree = await octokit.git.createTree({
      owner: input.repository.owner, repo: input.repository.repository, base_tree: baseCommit.data.commit.tree.sha, tree,
    });
    const commit = await octokit.git.createCommit({
      owner: input.repository.owner, repo: input.repository.repository,
      message: input.title, tree: createdTree.data.sha, parents: [input.baseSha],
    });
    try {
      await octokit.git.createRef({
        owner: input.repository.owner, repo: input.repository.repository,
        ref: `refs/heads/${input.branch}`, sha: commit.data.sha,
      });
    } catch (error) {
      if (!isGitHubAlreadyExists(error)) throw error;
      await octokit.git.updateRef({
        owner: input.repository.owner, repo: input.repository.repository,
        ref: `heads/${input.branch}`, sha: commit.data.sha, force: true,
      });
    }
    if (input.existingPullRequestUrl) return input.existingPullRequestUrl;
    return this.createDraftPullRequest(input);
  }

  async createDraftPullRequest(input: {
    repository: RepositoryProfile;
    branch: string;
    title: string;
    body: string;
  }): Promise<string> {
    const response = await this.requireClient().pulls.create({
      owner: input.repository.owner,
      repo: input.repository.repository,
      head: input.branch,
      base: input.repository.baseRef,
      title: input.title,
      body: input.body,
      draft: true,
    });
    return response.data.html_url;
  }

  async markPullRequestReady(url: string): Promise<void> {
    const parsed = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url);
    if (!parsed) throw new Error("Invalid GitHub pull request URL");
    await this.requireClient().request("POST /repos/{owner}/{repo}/pulls/{pull_number}/ready_for_review", {
      owner: parsed[1]!, repo: parsed[2]!, pull_number: Number(parsed[3]),
    });
  }

  private requireClient(): Octokit {
    if (!this.octokit) throw new Error("GitHub App authentication is not configured");
    return this.octokit;
  }
}

function isGitHubAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && error.status === 422);
}

async function changedFiles(root: string, allowedPaths: string[]): Promise<Array<{ path: string; deleted: boolean }>> {
  const { stdout } = await execFileAsync("git", ["diff", "--name-status", "-z", "HEAD", "--", ...allowedPaths], { cwd: root });
  const tokens = stdout.split("\0").filter(Boolean);
  const result: Array<{ path: string; deleted: boolean }> = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1;
      const target = tokens[index++];
      if (target) result.push({ path: target, deleted: false });
    } else {
      const path = tokens[index++];
      if (path) result.push({ path, deleted: status.startsWith("D") });
    }
  }
  return result;
}
