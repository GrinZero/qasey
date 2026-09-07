import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { resolveGitSourceSha } from "../../src/platform/e2e/build-metadata.ts";

const roots: string[] = [];
const branchSha = "a".repeat(40);
const detachedSha = "b".repeat(40);
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function worktree(absolute = false) {
  const root = mkdtempSync(join(tmpdir(), "qasey-worktree-metadata-"));
  roots.push(root);
  const project = join(root, "checkout");
  const common = join(root, "main", ".git");
  const gitdir = join(common, "worktrees", "feature");
  write(join(project, ".git"), `gitdir: ${absolute ? gitdir : relative(project, gitdir)}\n`);
  write(join(gitdir, "commondir"), `${absolute ? common : relative(gitdir, common)}\n`);
  write(join(gitdir, "HEAD"), "ref: refs/heads/feature\n");
  write(join(common, "HEAD"), `${detachedSha}\n`);
  return { project, common, gitdir };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("linked-worktree source metadata", () => {
  it.each([false, true])("reads shared loose branch refs with absolute paths=%s", absolute => {
    const { project, common } = worktree(absolute);
    write(join(common, "refs/heads/feature"), `${branchSha}\n`);
    expect(resolveGitSourceSha(project)).toBe(branchSha);
  });

  it("resolves shared packed refs and lets a newer loose branch ref win", () => {
    const { project, common } = worktree();
    write(join(common, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${branchSha} refs/heads/feature\n^${detachedSha}\n`);
    expect(resolveGitSourceSha(project)).toBe(branchSha);
    write(join(common, "refs/heads/feature"), detachedSha);
    expect(resolveGitSourceSha(project)).toBe(detachedSha);
  });

  it("keeps detached HEAD local even when the shared repository points elsewhere", () => {
    const { project, common, gitdir } = worktree();
    write(join(common, "refs/heads/feature"), branchSha);
    write(join(gitdir, "HEAD"), detachedSha);
    expect(resolveGitSourceSha(project)).toBe(detachedSha);
  });

  it("keeps per-worktree references local", () => {
    const { project, common, gitdir } = worktree();
    write(join(gitdir, "HEAD"), "ref: refs/worktree/local\n");
    write(join(gitdir, "refs/worktree/local"), branchSha);
    write(join(common, "refs/worktree/local"), detachedSha);
    expect(resolveGitSourceSha(project)).toBe(branchSha);
  });

  it("does not substitute the main checkout HEAD for an unresolved worktree branch", () => {
    const { project } = worktree();
    expect(resolveGitSourceSha(project)).toBeUndefined();
  });
});
