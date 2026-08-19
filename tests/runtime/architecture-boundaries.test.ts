import { access, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("shared runtime architecture boundaries", () => {
  it("has exactly one production Mastra constructor in the official entry point", async () => {
    const files = await sourceFiles(join(projectRoot, "src"));
    const matches: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/new\s+Mastra\s*\(/u.test(source)) matches.push(relative(projectRoot, file));
    }
    expect(matches).toEqual(["src/mastra/index.ts"]);
  });

  it("keeps the Application definition import-pure", async () => {
    const source = await readFile(join(projectRoot, "src/agent-apps/qasey/application.ts"), "utf8");
    expect(source).not.toMatch(/^import\s+(?!type).*\.\.\/\.\.\/mastra\//mu);
    await expect(import("../../src/agent-apps/qasey/application.ts"))
      .resolves.toMatchObject({ createQaseyApplication: expect.any(Function) });
  });

  it("does not retain legacy execution and queue entrypoints", async () => {
    const expectedRemoved = [
      "apps/api/src/slack-receiver.ts",
      "apps/worker/src/worker.ts",
      "packages/domain/src/trigger-queue.ts",
    ];
    for (const removed of expectedRemoved) {
      await expect(access(join(projectRoot, removed)), removed).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("builds and starts only the official Mastra worker artifact", async () => {
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const runtimeScript = await readFile(join(projectRoot, "ci/runtime.sh"), "utf8");
    expect(packageJson.scripts.build).toContain("mastra worker build --dir src/mastra --output-dir .mastra/worker");
    expect(runtimeScript).toContain("exec node .mastra/worker/index.mjs");
    await expect(access(join(projectRoot, "src/mastra/worker-entry.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Google OAuth in the platform layer without Mastra Enterprise auth", async () => {
    const [packageJson, runtimeSource, adminApiSource] = await Promise.all([
      readFile(join(projectRoot, "package.json"), "utf8"),
      readFile(join(projectRoot, "src/mastra/index.ts"), "utf8"),
      readFile(join(projectRoot, "apps/admin-ui/src/api.ts"), "utf8"),
    ]);
    expect(packageJson).not.toContain("@mastra/auth-google");
    expect(runtimeSource).not.toMatch(/MastraAuthGoogle|CompositeAuth|SimpleAuth|serverAuth/u);
    expect(adminApiSource).not.toContain("/api/auth/");
    expect(adminApiSource).toContain("/auth/google/login");
  });
});
