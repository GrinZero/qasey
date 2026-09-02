import { Octokit } from "@octokit/rest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepositoryProfile } from "../../contracts/src/index.ts";
import type { QaseyConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export type GitHubTokenConfig = Pick<QaseyConfig, "GITHUB_TOKEN">;

export type GitHubPublisherErrorCode =
  | "github_not_configured"
  | "github_publication_failed"
  | "github_pull_request_lookup_failed"
  | "github_pull_request_create_rejected"
  | "github_pull_request_url_invalid"
  | "github_pull_request_ready_failed";

const GITHUB_PUBLISHER_ERROR_MESSAGES: Record<GitHubPublisherErrorCode, string> = {
  github_not_configured: "GitHub personal access token authentication is not configured",
  github_publication_failed: "GitHub change publication failed",
  github_pull_request_lookup_failed: "GitHub pull request lookup failed",
  github_pull_request_create_rejected: "GitHub rejected pull request creation",
  github_pull_request_url_invalid: "Invalid GitHub pull request URL",
  github_pull_request_ready_failed: "GitHub pull request review transition failed",
};

export class GitHubPublisherError extends Error {
  constructor(readonly code: GitHubPublisherErrorCode) {
    super(GITHUB_PUBLISHER_ERROR_MESSAGES[code]);
    this.name = "GitHubPublisherError";
  }
}

export class GitHubPullRequestOutcomeUnknownError extends Error {
  readonly code = "side_effect_outcome_unknown";

  constructor() {
    super("GitHub pull request creation outcome requires operator reconciliation");
    this.name = "GitHubPullRequestOutcomeUnknownError";
  }
}

interface GitHubPullRequestInput {
  repository: RepositoryProfile;
  branch: string;
  title: string;
  body: string;
  existingPullRequestUrl?: string;
}

interface GitHubPublishChangesInput extends GitHubPullRequestInput {
  baseSha: string;
  changes: Array<{
    path: string;
    deleted: boolean;
    mode?: "100644" | "100755" | "120000";
    content?: Buffer;
  }>;
}

const PULL_REQUEST_KEY_MARKER = /(?:\r?\n)*<!-- qasey-pr-key:[a-f0-9]{64} -->/gu;

export function createGitHubClient(config: GitHubTokenConfig): Octokit | undefined {
  if (!config.GITHUB_TOKEN) return undefined;
  return new Octokit({ auth: config.GITHUB_TOKEN });
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
    try {
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
      return await this.publishChanges({ ...input, baseSha, changes: materialized });
    } catch (error) {
      throw safePublisherError(error, "github_publication_failed");
    }
  }

  async publishChanges(input: GitHubPublishChangesInput): Promise<string> {
    try {
      return await this.publishChangesUnchecked(input);
    } catch (error) {
      throw safePublisherError(error, "github_publication_failed");
    }
  }

  private async publishChangesUnchecked(input: GitHubPublishChangesInput): Promise<string> {
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
    return this.createDraftPullRequest(input);
  }

  async createDraftPullRequest(input: GitHubPullRequestInput): Promise<string> {
    const octokit = this.requireClient();
    const businessKey = stableGitHubPullRequestKey(input.repository, input.branch);
    const body = withPullRequestKey(input.body, businessKey);
    let existing: string | undefined;
    try {
      existing = await this.findOpenPullRequest(input, businessKey);
    } catch (error) {
      throw safePublisherError(error, "github_pull_request_lookup_failed");
    }
    if (existing) return existing;

    try {
      const response = await octokit.pulls.create({
        owner: input.repository.owner,
        repo: input.repository.repository,
        head: input.branch,
        base: input.repository.baseRef,
        title: input.title,
        body,
        draft: true,
      });
      if (typeof response.data.html_url === "string" && response.data.html_url.length > 0) {
        return response.data.html_url;
      }
    } catch (createError) {
      const reconciled = await this.reconcileAfterCreate(input, businessKey);
      if (reconciled) return reconciled;
      if (isDefiniteGitHubRejection(createError)) {
        throw new GitHubPublisherError("github_pull_request_create_rejected");
      }
      throw new GitHubPullRequestOutcomeUnknownError();
    }

    const reconciled = await this.reconcileAfterCreate(input, businessKey);
    if (reconciled) return reconciled;
    throw new GitHubPullRequestOutcomeUnknownError();
  }

  async markPullRequestReady(url: string): Promise<void> {
    const parsed = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url);
    if (!parsed) throw new GitHubPublisherError("github_pull_request_url_invalid");
    try {
      await this.requireClient().request("POST /repos/{owner}/{repo}/pulls/{pull_number}/ready_for_review", {
        owner: parsed[1]!, repo: parsed[2]!, pull_number: Number(parsed[3]),
      });
    } catch (error) {
      throw safePublisherError(error, "github_pull_request_ready_failed");
    }
  }

  private requireClient(): Octokit {
    if (!this.octokit) throw new GitHubPublisherError("github_not_configured");
    return this.octokit;
  }

  private async findOpenPullRequest(
    input: Pick<GitHubPullRequestInput, "repository" | "branch" | "existingPullRequestUrl">,
    businessKey: string,
  ): Promise<string | undefined> {
    const response = await this.requireClient().pulls.list({
      owner: input.repository.owner,
      repo: input.repository.repository,
      state: "open",
      head: `${input.repository.owner}:${input.branch}`,
      base: input.repository.baseRef,
      per_page: 100,
    });
    const expectedRepository = `${input.repository.owner}/${input.repository.repository}`.toLowerCase();
    const matches = response.data.filter(pull =>
      pull.state === "open"
      && pull.head.ref === input.branch
      && pull.base.ref === input.repository.baseRef
      && pull.head.repo?.full_name.toLowerCase() === expectedRepository,
    );
    const marker = pullRequestMarker(businessKey);
    const marked = matches.filter(pull => pull.body?.includes(marker));
    if (marked.length === 1) return marked[0]!.html_url;
    if (marked.length > 1) throw new GitHubPullRequestOutcomeUnknownError();
    if (input.existingPullRequestUrl) {
      const hinted = matches.filter(pull => pull.html_url === input.existingPullRequestUrl);
      if (hinted.length === 1) return hinted[0]!.html_url;
    }
    if (matches.length === 1) return matches[0]!.html_url;
    if (matches.length > 1) throw new GitHubPullRequestOutcomeUnknownError();
    return undefined;
  }

  private async reconcileAfterCreate(input: GitHubPullRequestInput, businessKey: string): Promise<string | undefined> {
    try {
      return await this.findOpenPullRequest(input, businessKey);
    } catch {
      throw new GitHubPullRequestOutcomeUnknownError();
    }
  }
}

export function stableGitHubPullRequestKey(
  repository: Pick<RepositoryProfile, "owner" | "repository" | "baseRef">,
  branch: string,
): string {
  return createHash("sha256")
    .update(["qasey-github-pr-v1", repository.owner.toLowerCase(), repository.repository.toLowerCase(), repository.baseRef, branch].join("\0"))
    .digest("hex");
}

function pullRequestMarker(businessKey: string): string {
  return `<!-- qasey-pr-key:${businessKey} -->`;
}

function withPullRequestKey(body: string, businessKey: string): string {
  const content = body.replace(PULL_REQUEST_KEY_MARKER, "").trimEnd();
  return `${content}${content ? "\n\n" : ""}${pullRequestMarker(businessKey)}`;
}

function safePublisherError(error: unknown, fallback: GitHubPublisherErrorCode): Error {
  if (error instanceof GitHubPublisherError || error instanceof GitHubPullRequestOutcomeUnknownError) return error;
  return new GitHubPublisherError(fallback);
}

function isGitHubAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && error.status === 422);
}

function isDefiniteGitHubRejection(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && (error.status === 403 || error.status === 422),
  );
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
