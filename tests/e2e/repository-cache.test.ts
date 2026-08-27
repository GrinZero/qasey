import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runSafeCommand, SharedRepositoryCache } from "../../packages/e2e/src/index.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe("shared repository cache", () => {
  it("uses one mirror and independent pinned worktrees for author and verifier attempts", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "qasey-repo-"));
    const attempts = await mkdtemp(join(tmpdir(), "qasey-attempts-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "qasey-cache-"));
    cleanup.push(fixture, attempts, cacheRoot);
    await mkdir(join(fixture, "tests"));
    await writeFile(join(fixture, "tests", ".gitkeep"), "");
    await writeFile(join(fixture, "README.md"), "fixture\n");
    await git(fixture, ["init", "-b", "main"]);
    await git(fixture, ["add", "."]);
    await git(fixture, ["-c", "user.name=Qasey", "-c", "user.email=qasey@example.test", "commit", "-m", "base"]);

    const cache = new SharedRepositoryCache(cacheRoot);
    const source = {
      namespace: "tenant",
      owner: "local",
      repository: "fixture",
      cloneUrl: fixture,
    };
    const author = await cache.createWorktree(source, join(attempts, "author"), {
      ref: "main",
      branch: "qasey/test",
    });
    if (!author.resolvedSha) throw new Error("Author worktree did not resolve its base SHA");

    await writeFile(join(fixture, "README.md"), "new upstream commit\n");
    await git(fixture, ["add", "README.md"]);
    await git(fixture, ["-c", "user.name=Qasey", "-c", "user.email=qasey@example.test", "commit", "-m", "upstream"]);
    const verifier = await cache.createWorktree(source, join(attempts, "verifier"), {
      ref: "main",
      baseSha: author.resolvedSha,
      detached: true,
    });

    expect(author.mirrorPath).toBe(verifier.mirrorPath);
    expect(author.destination).not.toBe(verifier.destination);
    expect(author.cacheHit).toBe(false);
    expect(verifier.cacheHit).toBe(true);
    expect(await readdir(join(cacheRoot, "tenant"))).toHaveLength(1);
    await expect(readFile(join(verifier.destination, "README.md"), "utf8")).resolves.toBe("fixture\n");

    await writeFile(join(author.destination, "tests", "generated.spec.ts"), "export const generated = true;\n");
    await expect(readFile(join(verifier.destination, "tests", "generated.spec.ts"), "utf8")).rejects.toThrow();
    const detached = await runSafeCommand({
      executable: "git",
      args: ["symbolic-ref", "-q", "HEAD"],
      cwd: verifier.destination,
    });
    expect(detached.exitCode).not.toBe(0);
  });

  it("reuses an isolated-checkout mirror when Git rewrites its transport URL", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "qasey-rewrite-origin-"));
    const attempts = await mkdtemp(join(tmpdir(), "qasey-rewrite-attempts-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "qasey-rewrite-cache-"));
    const configRoot = await mkdtemp(join(tmpdir(), "qasey-rewrite-config-"));
    cleanup.push(fixture, attempts, cacheRoot, configRoot);
    await writeFile(join(fixture, "README.md"), "fixture\n");
    await git(fixture, ["init", "-b", "main"]);
    await git(fixture, ["add", "."]);
    await git(fixture, ["-c", "user.name=Qasey", "-c", "user.email=qasey@example.test", "commit", "-m", "base"]);

    const cloneUrl = "https://github.com/example/rewrite-fixture.git";
    const gitConfig = join(configRoot, "gitconfig");
    const configureRewrite = await runSafeCommand({
      executable: "git",
      args: ["config", "--file", gitConfig, `url.${fixture}.insteadOf`, cloneUrl],
      cwd: fixture,
    });
    expect(configureRewrite.exitCode).toBe(0);
    const env = {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const source = {
      namespace: "tenant",
      owner: "example",
      repository: "rewrite-fixture",
      cloneUrl,
    };
    const cache = new SharedRepositoryCache(cacheRoot);
    const first = await cache.createIsolatedCheckout(source, join(attempts, "first"), {
      ref: "main",
      env,
    });
    if (!first.resolvedSha) throw new Error("First isolated checkout did not resolve its base SHA");
    const second = await cache.createIsolatedCheckout(source, join(attempts, "second"), {
      ref: "main",
      baseSha: first.resolvedSha,
      env,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.mirrorPath).toBe(first.mirrorPath);
    await expect(readFile(join(first.destination, "README.md"), "utf8")).resolves.toBe("fixture\n");
    await expect(readFile(join(second.destination, "README.md"), "utf8")).resolves.toBe("fixture\n");
    await expect(readFile(join(first.destination, ".git", "objects", "info", "alternates"), "utf8")).rejects.toThrow();
    await expect(readFile(join(second.destination, ".git", "objects", "info", "alternates"), "utf8")).rejects.toThrow();
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runSafeCommand({ executable: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}
