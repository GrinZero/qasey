import { mkdir, mkdtemp, rm, cp, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import type { RepositoryProfile } from "../../contracts/src/index.ts";
import { runSafeCommand, type CommandResult, type SafeCommand } from "./process.ts";
import { SharedRepositoryCache } from "./repository-cache.ts";

export interface WorkspaceCreateOptions {
  namespace?: string;
  purpose?: "author" | "verifier" | "inspect";
  branch?: string;
  baseSha?: string;
}

export interface WorkspaceRef {
  id: string;
  root: string;
  gitDir: string;
  repository: RepositoryProfile;
  branch: string;
  baseSha: string;
  purpose: NonNullable<WorkspaceCreateOptions["purpose"]>;
}

export interface WorkspaceManager {
  create(repository: RepositoryProfile, runId: string, options?: WorkspaceCreateOptions): Promise<WorkspaceRef>;
  exec(ref: WorkspaceRef, executable: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
  collectPatch(ref: WorkspaceRef): Promise<string>;
  changedPaths(ref: WorkspaceRef): Promise<string[]>;
  assertAllowedChanges(ref: WorkspaceRef): Promise<void>;
  applyPatch(ref: WorkspaceRef, patch: string): Promise<void>;
  assertWritablePath(ref: WorkspaceRef, targetPath: string): Promise<void>;
  destroy(ref: WorkspaceRef): Promise<void>;
}

export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly refs = new Map<string, WorkspaceRef>();
  private readonly repositoryCache: SharedRepositoryCache;

  constructor(private readonly workspaceRoot: string, cacheRoot = join(resolve(workspaceRoot), "..", "git-cache")) {
    this.repositoryCache = new SharedRepositoryCache(cacheRoot);
  }

  async create(repository: RepositoryProfile, runId: string, options: WorkspaceCreateOptions = {}): Promise<WorkspaceRef> {
    const absoluteRoot = resolve(this.workspaceRoot);
    await mkdir(absoluteRoot, { recursive: true });
    const container = await mkdtemp(join(absoluteRoot, `${safeName(runId)}-`));
    const root = join(container, "worktree");
    const gitDir = join(container, "store.git");
    const purpose = options.purpose ?? "author";
    const branch = options.branch ?? `qasey/${safeName(runId)}`;
    const materialized = await this.repositoryCache.materialize({
      namespace: options.namespace ?? "local",
      owner: repository.owner,
      repository: repository.repository,
      cloneUrl: repository.cloneUrl,
    }, gitDir, {
      bare: true,
      ref: repository.baseRef,
      timeoutMs: 120_000,
    });
    const baseSha = options.baseSha ?? materialized.resolvedSha;
    if (!baseSha) throw new Error(`Unable to resolve base ref ${repository.baseRef}`);
    const hasCommit = await runSafeCommand({ executable: "git", args: ["--git-dir", gitDir, "cat-file", "-e", `${baseSha}^{commit}`], cwd: container });
    if (hasCommit.exitCode !== 0) throw new Error(`Pinned base commit is unavailable: ${baseSha}`);
    const worktreeArgs = purpose === "author"
      ? ["--git-dir", gitDir, "worktree", "add", "-b", branch, "--", root, baseSha]
      : ["--git-dir", gitDir, "worktree", "add", "--detach", "--", root, baseSha];
    const checkout = await runSafeCommand({ executable: "git", args: worktreeArgs, cwd: container });
    if (checkout.exitCode !== 0) throw new Error(`git worktree add failed: ${checkout.stderr.slice(-1000)}`);
    const ref = { id: runId, root, gitDir, repository, branch, baseSha, purpose };
    this.refs.set(runId, ref);
    return ref;
  }

  async exec(ref: WorkspaceRef, executable: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
    this.assertManaged(ref);
    const command: SafeCommand = { executable, args, cwd: ref.root, ...(timeoutMs ? { timeoutMs } : {}) };
    return runSafeCommand(command);
  }

  async collectPatch(ref: WorkspaceRef): Promise<string> {
    const intentToAdd = await this.exec(ref, "git", ["add", "-N", "--", ...ref.repository.allowedPaths]);
    if (intentToAdd.exitCode !== 0) throw new Error(`git add -N failed: ${intentToAdd.stderr}`);
    const result = await this.exec(ref, "git", ["diff", "HEAD", "--binary", "--", ...ref.repository.allowedPaths]);
    if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr}`);
    return result.stdout;
  }

  async changedPaths(ref: WorkspaceRef): Promise<string[]> {
    const result = await this.exec(ref, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr}`);
    const entries = result.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const status = entry.slice(0, 2);
      paths.push(entry.slice(3));
      if (status.includes("R") || status.includes("C")) paths.push(entries[++index] ?? "");
    }
    return [...new Set(paths.filter(Boolean))].sort();
  }

  async assertAllowedChanges(ref: WorkspaceRef): Promise<void> {
    const changed = await this.changedPaths(ref);
    for (const path of changed) await this.assertWritablePath(ref, path);
    if (changed.length === 0) throw new Error("Coding harness produced no repository changes");
  }

  async applyPatch(ref: WorkspaceRef, patch: string): Promise<void> {
    this.assertManaged(ref);
    if (!patch.trim()) throw new Error("Cannot verify an empty patch");
    const patchPath = join(resolve(ref.root, ".."), `${safeName(ref.id)}.patch`);
    await writeFile(patchPath, patch, { mode: 0o600 });
    try {
      const result = await this.exec(ref, "git", ["apply", "--index", "--binary", "--", patchPath]);
      if (result.exitCode !== 0) throw new Error(`git apply failed: ${result.stderr}`);
    } finally {
      await rm(patchPath, { force: true });
    }
    await this.assertAllowedChanges(ref);
  }

  async assertWritablePath(ref: WorkspaceRef, targetPath: string): Promise<void> {
    this.assertManaged(ref);
    const target = resolve(ref.root, targetPath);
    const rel = relative(ref.root, target);
    if (rel.startsWith("..") || resolve(ref.root, rel) !== target) throw new Error("Path escapes workspace");
    const allowed = ref.repository.allowedPaths.some(path => rel === path || rel.startsWith(`${path}/`));
    if (!allowed) throw new Error(`Path is outside allowedPaths: ${rel}`);
  }

  async destroy(ref: WorkspaceRef): Promise<void> {
    this.assertManaged(ref);
    const workspaceRoot = await realpath(resolve(this.workspaceRoot));
    const container = await realpath(resolve(ref.root, ".."));
    if (!container.startsWith(`${workspaceRoot}/`)) throw new Error("Refusing to delete outside workspace root");
    await runSafeCommand({
      executable: "git",
      args: ["--git-dir", ref.gitDir, "worktree", "remove", "--force", "--", ref.root],
      cwd: container,
    }).catch(() => undefined);
    await rm(container, { recursive: true, force: true });
    this.refs.delete(ref.id);
  }

  private assertManaged(ref: WorkspaceRef): void {
    if (this.refs.get(ref.id)?.root !== ref.root) throw new Error("Unknown workspace reference");
  }
}

export async function copyFixture(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true });
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "run";
}
