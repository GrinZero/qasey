import { Octokit } from "@octokit/rest";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepositoryProfile } from "../../contracts/src/index.ts";

const execFileAsync = promisify(execFile);

export class GitHubPublisher {
  private readonly octokit: Octokit | undefined;
  constructor(token?: string) { this.octokit = token ? new Octokit({ auth: token }) : undefined; }
  get configured(): boolean { return Boolean(this.octokit); }

  async publishWorkspace(input: {
    repository: RepositoryProfile;
    root: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<string> {
    const octokit = this.requireClient();
    const { stdout: baseOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: input.root });
    const baseSha = baseOutput.trim();
    const changes = await changedFiles(input.root, input.repository.allowedPaths);
    if (changes.length === 0) throw new Error("Refusing to publish an empty change");
    const tree: Array<{ path: string; mode: "100644" | "100755" | "120000"; type: "blob"; sha: string | null }> = [];
    for (const change of changes) {
      if (change.deleted) {
        tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const absolute = join(input.root, change.path);
      const stats = await lstat(absolute);
      const content = stats.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
      const blob = await octokit.git.createBlob({
        owner: input.repository.owner, repo: input.repository.repository,
        content: content.toString("base64"), encoding: "base64",
      });
      tree.push({ path: change.path, mode: stats.isSymbolicLink() ? "120000" : stats.mode & 0o111 ? "100755" : "100644", type: "blob", sha: blob.data.sha });
    }
    const createdTree = await octokit.git.createTree({
      owner: input.repository.owner, repo: input.repository.repository, base_tree: baseSha, tree,
    });
    const commit = await octokit.git.createCommit({
      owner: input.repository.owner, repo: input.repository.repository,
      message: input.title, tree: createdTree.data.sha, parents: [baseSha],
    });
    await octokit.git.createRef({
      owner: input.repository.owner, repo: input.repository.repository,
      ref: `refs/heads/${input.branch}`, sha: commit.data.sha,
    });
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
    if (!this.octokit) throw new Error("GITHUB_TOKEN is not configured");
    return this.octokit;
  }
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
