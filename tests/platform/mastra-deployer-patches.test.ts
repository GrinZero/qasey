import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("patched Mastra deployer pnpm output", () => {
  it("copies patchedDependencies and their files into the isolated runtime", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "qasey-mastra-patches-"));
    temporaryDirectories.push(fixtureRoot);
    const sourceRoot = join(fixtureRoot, "source");
    const outputRoot = join(fixtureRoot, "output");
    await Promise.all([
      mkdir(join(sourceRoot, "patches"), { recursive: true }),
      mkdir(outputRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8"),
      writeFile(join(sourceRoot, "patches", "core.patch"), "core patch\n", "utf8"),
      writeFile(join(sourceRoot, "patches", "cli.patch"), "cli patch\n", "utf8"),
      writeFile(join(sourceRoot, "pnpm-workspace.yaml"), [
        "packages:",
        "  - '.'",
        "patchedDependencies:",
        "  '@mastra/core@1.59.0': patches/core.patch",
        "  mastra@1.25.0: patches/cli.patch",
        "",
      ].join("\n"), "utf8"),
    ]);

    const require = createRequire(import.meta.url);
    const mastraRequire = createRequire(require.resolve("mastra/package.json"));
    const deployerPackagePath = mastraRequire.resolve("@mastra/deployer/package.json");
    const deployer = await import(pathToFileURL(join(dirname(deployerPackagePath), "dist/index.js")).href) as {
      Deps: new (rootDir: string) => {
        writePnpmConfig(outputDir: string): Promise<void>;
      };
    };
    const deps = new deployer.Deps(sourceRoot);
    await deps.writePnpmConfig(outputRoot);

    const outputWorkspace = await readFile(join(outputRoot, "pnpm-workspace.yaml"), "utf8");
    expect(outputWorkspace).toContain("patchedDependencies:");
    expect(outputWorkspace).toContain('"@mastra/core@1.59.0": ".mastra-patches/0-core.patch"');
    expect(outputWorkspace).toContain('"mastra@1.25.0": ".mastra-patches/1-cli.patch"');
    expect(outputWorkspace).toContain("allowUnusedPatches: true");

    const copiedPatchNames = await readdir(join(outputRoot, ".mastra-patches"));
    expect(copiedPatchNames.sort()).toEqual(["0-core.patch", "1-cli.patch"]);
    await expect(readFile(join(outputRoot, ".mastra-patches", "0-core.patch"), "utf8"))
      .resolves.toBe("core patch\n");
    await expect(readFile(join(outputRoot, ".mastra-patches", "1-cli.patch"), "utf8"))
      .resolves.toBe("cli patch\n");
  });
});
