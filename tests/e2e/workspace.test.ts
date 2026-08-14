import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runSafeCommand, LocalWorkspaceManager } from "../../packages/e2e/src/index.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe("local author and clean verifier workspaces", () => {
  it("collects untracked files, blocks scope escape, and applies the patch to a clean checkout", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "qasey-repo-"));
    const spaces = await mkdtemp(join(tmpdir(), "qasey-spaces-"));
    cleanup.push(fixture, spaces);
    await mkdir(join(fixture, "tests"));
    await writeFile(join(fixture, "tests", ".gitkeep"), "");
    await writeFile(join(fixture, "README.md"), "fixture\n");
    await runSafeCommand({ executable: "git", args: ["init", "-b", "main"], cwd: fixture });
    await runSafeCommand({ executable: "git", args: ["add", "."], cwd: fixture });
    await runSafeCommand({ executable: "git", args: ["-c", "user.name=Qasey", "-c", "user.email=qasey@example.test", "commit", "-m", "base"], cwd: fixture });
    const manager = new LocalWorkspaceManager(spaces);
    const repository = { owner: "local", repository: "fixture", cloneUrl: fixture, baseRef: "main", allowedPaths: ["tests"], skillsPaths: [] };
    const author = await manager.create(repository, "author");
    const verifier = await manager.create(repository, "verifier");
    try {
      await writeFile(join(author.root, "tests", "generated.spec.ts"), "export const generated = true;\n");
      await manager.assertAllowedChanges(author);
      await expect(manager.assertWritablePath(author, "src/product.ts")).rejects.toThrow(/outside allowedPaths/);
      const patch = await manager.collectPatch(author);
      expect(patch).toContain("generated.spec.ts");
      await manager.applyPatch(verifier, patch);
      await expect(readFile(join(verifier.root, "tests", "generated.spec.ts"), "utf8")).resolves.toContain("generated");
    } finally {
      await manager.destroy(author);
      await manager.destroy(verifier);
    }
  });
});
