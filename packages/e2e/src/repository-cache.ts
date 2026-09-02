import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { runSafeCommand, type CommandResult } from "./process.ts";

export interface RepositoryCacheSource {
  namespace: string;
  owner: string;
  repository: string;
  cloneUrl: string;
}

export interface MaterializeRepositoryOptions {
  bare?: boolean;
  ref?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CreateRepositoryWorktreeOptions extends Omit<MaterializeRepositoryOptions, "bare"> {
  baseSha?: string;
  branch?: string;
  detached?: boolean;
}

export interface MaterializedRepository {
  cacheHit: boolean;
  mirrorPath: string;
  destination: string;
  resolvedSha?: string;
}

/**
 * One preparation mirror per repository namespace. Code Tasks call
 * createIsolatedCheckout() so only fetch work is shared; every attempt owns
 * its Git metadata and object files. createWorktree() remains for trusted
 * callers that intentionally share the mirror's object store.
 */
export class SharedRepositoryCache {
  constructor(
    private readonly root: string,
    private readonly options: { lockTimeoutMs?: number; staleLockMs?: number } = {},
  ) {}

  async materialize(
    source: RepositoryCacheSource,
    destinationInput: string,
    options: MaterializeRepositoryOptions = {},
  ): Promise<MaterializedRepository> {
    const cacheRoot = resolve(this.root);
    const namespaceRoot = containedPath(cacheRoot, safeSegment(source.namespace));
    const mirrorPath = containedPath(namespaceRoot, `${repositoryKey(source)}.git`);
    const destination = resolve(destinationInput);
    await Promise.all([
      mkdir(namespaceRoot, { recursive: true, mode: 0o700 }),
      mkdir(dirname(destination), { recursive: true, mode: 0o700 }),
    ]);
    if (await exists(destination)) throw new Error(`Repository destination already exists: ${destination}`);

    return this.withRepositoryLock(mirrorPath, async () => {
      const prepared = await prepareMirror(source, mirrorPath, options);
      const cloneArgs = ["clone", "--local", ...(options.bare ? ["--bare"] : []), "--", mirrorPath, destination];
      const localClone = await git(dirname(destination), cloneArgs, options);
      if (localClone.exitCode !== 0) {
        await rm(destination, { recursive: true, force: true });
        assertGit(localClone, "git local clone");
      }
      const setRemote = await git(options.bare ? destination : join(destination, ".git"), ["remote", "set-url", "origin", source.cloneUrl], options, true);
      assertGit(setRemote, "git local origin configuration");
      return { ...prepared, mirrorPath, destination };
    });
  }

  async createWorktree(
    source: RepositoryCacheSource,
    destinationInput: string,
    options: CreateRepositoryWorktreeOptions = {},
  ): Promise<MaterializedRepository> {
    const cacheRoot = resolve(this.root);
    const namespaceRoot = containedPath(cacheRoot, safeSegment(source.namespace));
    const mirrorPath = containedPath(namespaceRoot, `${repositoryKey(source)}.git`);
    const destination = resolve(destinationInput);
    await Promise.all([
      mkdir(namespaceRoot, { recursive: true, mode: 0o700 }),
      mkdir(dirname(destination), { recursive: true, mode: 0o700 }),
    ]);
    if (await exists(destination)) throw new Error(`Repository worktree destination already exists: ${destination}`);

    return this.withRepositoryLock(mirrorPath, async () => {
      const prepared = await prepareMirror(source, mirrorPath, options);
      const baseSha = options.baseSha ?? prepared.resolvedSha;
      if (!baseSha) throw new Error("A pinned base SHA or resolvable ref is required to create a worktree");
      const hasCommit = await git(mirrorPath, ["cat-file", "-e", `${baseSha}^{commit}`], options);
      assertGit(hasCommit, `verify pinned base commit ${baseSha}`);
      const prune = await git(mirrorPath, ["worktree", "prune"], options);
      assertGit(prune, "git worktree prune");
      const checkoutArgs = options.detached || !options.branch
        ? ["worktree", "add", "--detach", "--", destination, baseSha]
        : ["worktree", "add", "-b", options.branch, "--", destination, baseSha];
      const checkout = await git(mirrorPath, checkoutArgs, options);
      if (checkout.exitCode !== 0) {
        await rm(destination, { recursive: true, force: true });
        assertGit(checkout, "git worktree add");
      }
      return { ...prepared, mirrorPath, destination, resolvedSha: baseSha };
    });
  }

  /**
   * Materialize a Code Task checkout with its own Git directory and object
   * files. The shared mirror is only a preparation source: no alternates,
   * hardlinks, or worktree metadata point back to the shared cache at runtime.
   */
  async createIsolatedCheckout(
    source: RepositoryCacheSource,
    destinationInput: string,
    options: CreateRepositoryWorktreeOptions,
  ): Promise<MaterializedRepository> {
    const cacheRoot = resolve(this.root);
    const namespaceRoot = containedPath(cacheRoot, safeSegment(source.namespace));
    const mirrorPath = containedPath(namespaceRoot, `${repositoryKey(source)}.git`);
    const destination = resolve(destinationInput);
    await Promise.all([
      mkdir(namespaceRoot, { recursive: true, mode: 0o700 }),
      mkdir(dirname(destination), { recursive: true, mode: 0o700 }),
    ]);
    if (await exists(destination)) throw new Error(`Repository checkout destination already exists: ${destination}`);

    return this.withRepositoryLock(mirrorPath, async () => {
      const prepared = await prepareMirror(source, mirrorPath, options);
      const baseSha = options.baseSha ?? prepared.resolvedSha;
      if (!baseSha) throw new Error("A pinned base SHA is required to create an isolated checkout");
      const hasCommit = await git(mirrorPath, ["cat-file", "-e", `${baseSha}^{commit}`], options);
      assertGit(hasCommit, `verify pinned base commit ${baseSha}`);
      const clone = await git(dirname(destination), [
        "clone", "--local", "--no-hardlinks", "--no-checkout", "--", mirrorPath, destination,
      ], options);
      if (clone.exitCode !== 0) {
        await rm(destination, { recursive: true, force: true });
        assertGit(clone, "git isolated clone");
      }
      const setRemote = await git(join(destination, ".git"), ["remote", "set-url", "origin", source.cloneUrl], options, true);
      assertGit(setRemote, "git isolated origin configuration");
      const checkout = await git(destination, ["checkout", "--detach", "--force", baseSha], options);
      if (checkout.exitCode !== 0) {
        await rm(destination, { recursive: true, force: true });
        assertGit(checkout, `git checkout pinned commit ${baseSha}`);
      }
      const head = await git(destination, ["rev-parse", "HEAD"], options);
      assertGit(head, "verify isolated checkout HEAD");
      if (head.stdout.trim() !== baseSha) throw new Error(`Isolated checkout resolved ${head.stdout.trim()} instead of ${baseSha}`);
      if (await exists(join(destination, ".git", "objects", "info", "alternates"))) {
        throw new Error("Isolated checkout unexpectedly references a shared Git object store");
      }
      return { ...prepared, mirrorPath, destination, resolvedSha: baseSha };
    });
  }

  private async withRepositoryLock<T>(mirrorPath: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = `${mirrorPath}.lock`;
    const timeoutMs = this.options.lockTimeoutMs ?? 120_000;
    const staleLockMs = this.options.staleLockMs ?? 10 * 60_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        await writeFile(join(lockPath, "owner"), `${process.pid}:${randomUUID()}\n`, { mode: 0o600 });
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const metadata = await stat(lockPath).catch(() => undefined);
        if (metadata && Date.now() - metadata.mtimeMs > staleLockMs) {
          const owner = await readFile(join(lockPath, "owner"), "utf8").catch(() => "unknown");
          const stalePath = `${lockPath}.stale-${createHash("sha256").update(owner).digest("hex").slice(0, 12)}-${Date.now()}`;
          await import("node:fs/promises").then(fs => fs.rename(lockPath, stalePath)).catch(() => undefined);
          await rm(stalePath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for repository cache lock: ${mirrorPath}`);
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function prepareMirror(
  source: RepositoryCacheSource,
  mirrorPath: string,
  options: MaterializeRepositoryOptions,
): Promise<Pick<MaterializedRepository, "cacheHit" | "resolvedSha">> {
  const cacheHit = await exists(mirrorPath);
  if (!cacheHit) {
    const clone = await git(dirname(mirrorPath), ["clone", "--mirror", "--", source.cloneUrl, mirrorPath], options);
    assertGit(clone, "git mirror clone");
  } else {
    // Read the literal configuration value. `git remote get-url` expands
    // url.<base>.insteadOf rules, so a trusted CI rewrite from an HTTPS URL to
    // a local fixture would otherwise look like cache-key poisoning on the
    // second checkout of the same repository.
    const configuredRemote = await git(mirrorPath, ["config", "--get", "remote.origin.url"], options);
    assertGit(configuredRemote, "git mirror remote inspection");
    if (normalizeRemote(configuredRemote.stdout) !== normalizeRemote(source.cloneUrl)) {
      throw new Error("Repository cache key resolved to a different origin URL");
    }
  }

  const fetchArgs = options.ref
    ? ["fetch", "--prune", "origin", `+refs/heads/${options.ref}:refs/heads/${options.ref}`]
    : ["remote", "update", "--prune"];
  const refresh = await gitWithTransientRetry(mirrorPath, fetchArgs, options);
  assertGit(refresh, "git mirror refresh");
  const resolvedSha = options.ref ? await resolveCommit(mirrorPath, options.ref, options) : undefined;
  return { cacheHit, ...(resolvedSha ? { resolvedSha } : {}) };
}

async function gitWithTransientRetry(
  cwd: string,
  args: string[],
  options: MaterializeRepositoryOptions,
): Promise<CommandResult> {
  let result = await git(cwd, args, options);
  for (let attempt = 1; attempt < 3 && result.exitCode !== 0 && isTransientGitNetworkFailure(result); attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, attempt * 500));
    result = await git(cwd, args, options);
  }
  return result;
}

function isTransientGitNetworkFailure(result: CommandResult): boolean {
  return /Could not resolve host|Failed to connect|Connection reset|gnutls_handshake|remote end hung up|TLS connection|HTTP (?:5\d\d|429)/iu
    .test(`${result.stdout}\n${result.stderr}`);
}

async function resolveCommit(
  mirrorPath: string,
  ref: string,
  options: MaterializeRepositoryOptions,
): Promise<string> {
  const result = await git(mirrorPath, ["rev-parse", `refs/heads/${ref}^{commit}`], options);
  assertGit(result, `resolve repository ref ${ref}`);
  const sha = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(sha)) throw new Error(`Git resolved an invalid commit SHA for ${ref}`);
  return sha;
}

function git(
  cwd: string,
  args: string[],
  options: MaterializeRepositoryOptions,
  gitDir = false,
): Promise<CommandResult> {
  return runSafeCommand({
    executable: "git",
    args: gitDir ? ["--git-dir", cwd, ...args] : args,
    cwd: gitDir ? dirname(cwd) : cwd,
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: options.timeoutMs ?? 120_000,
  });
}

function assertGit(result: CommandResult, operation: string): void {
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.slice(-1500)}`);
}

function repositoryKey(source: RepositoryCacheSource): string {
  const identity = `${normalizeRemote(source.cloneUrl)}\0${source.owner.toLowerCase()}\0${source.repository.toLowerCase()}`;
  return createHash("sha256").update(identity).digest("hex");
}

function normalizeRemote(value: string): string {
  return value.trim().replace(/\/+$/u, "").replace(/\.git$/u, "").toLowerCase();
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/^\.+$/u, "-").slice(0, 160);
  if (!segment) throw new Error("Repository cache namespace is empty");
  return segment;
}

function containedPath(rootInput: string, child: string): string {
  const root = resolve(rootInput);
  const target = resolve(root, child);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Repository cache path escaped its root");
  return target;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
