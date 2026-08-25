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
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runSafeCommand({ executable: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}
