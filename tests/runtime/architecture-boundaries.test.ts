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
    const source = await readFile(join(projectRoot, "src/mastra/applications/qasey/application.ts"), "utf8");
    expect(source).not.toMatch(/^import\s+(?!type).*\.\.\/\.\.\/mastra\//mu);
    await expect(import("../../src/mastra/applications/qasey/application.ts"))
      .resolves.toMatchObject({ createQaseyApplication: expect.any(Function) });
  });

  it("uses Mastra file discovery as the only Qasey Agent registration source", async () => {
    const [applicationSource, runtimeSource, serviceSource, slackTunnelSource] = await Promise.all([
      readFile(join(projectRoot, "src/mastra/applications/qasey/application.ts"), "utf8"),
      readFile(join(projectRoot, "src/mastra/index.ts"), "utf8"),
      readFile(join(projectRoot, "src/mastra/applications/qasey/service.ts"), "utf8"),
      readFile(join(projectRoot, "src/mastra/applications/qasey/slack-tunnel-command.ts"), "utf8"),
    ]);
    expect(applicationSource).toContain('filesystemAgents: ["qasey-main"]');
    expect(runtimeSource).not.toMatch(/agents\/qasey-(?:main|intent-router)\/agent/u);
    expect(runtimeSource).not.toContain("await registerQaseySlackTunnelCommand(mastra)");
    expect(runtimeSource).toContain("runtimeReadiness.register(\"slack-tunnel-command\"");
    expect(slackTunnelSource).toContain('mastra.listAgents()["qasey-main"]');
    expect(slackTunnelSource).not.toContain('mastra.getAgent("qasey-main")');
    expect(serviceSource).toContain('mastra.getAgent("qasey-main")');
    expect(serviceSource).not.toContain('mastra.getAgent("qasey-intent-router")');
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

  it("routes public Qasey tasks directly to the Durable Agent and keeps writes behind Case Hub", async () => {
    const [runtimeSource, routeSource, adminApiSource] = await Promise.all([
      readFile(join(projectRoot, "src/mastra/runtime.ts"), "utf8"),
      readFile(join(projectRoot, "src/mastra/applications/qasey/routes.ts"), "utf8"),
      readFile(join(projectRoot, "apps/admin-ui/src/api.ts"), "utf8"),
    ]);
    await expect(access(join(projectRoot, "src/mastra/workflows/qasey-task-workflow.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtimeSource).toContain('id: "case_hub_create_change_set"');
    expect(routeSource).not.toContain('getAgent("qasey-main").generate');
    expect(routeSource).toContain("executeQasey");
    expect(routeSource).not.toContain("runQaseyTaskWorkflow");
    expect(adminApiSource).toContain('"/v1/qasey/conversations"');
    expect(adminApiSource).not.toContain('"/v1/qasey/tasks"');
    expect(adminApiSource).not.toContain("/studio/api/agents/");
  });

  it("bundles protected Studio and builds only the official Mastra worker artifact", async () => {
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const [runtimeScript, mastraSource] = await Promise.all([
      readFile(join(projectRoot, "ci/runtime.sh"), "utf8"),
      readFile(join(projectRoot, "src/mastra/index.ts"), "utf8"),
    ]);
    expect(packageJson.scripts.build).toContain("mastra build --dir src/mastra --studio");
    expect(mastraSource).toContain("studioUiEnabled: true");
    expect(runtimeScript).toContain('MASTRA_AUTO_DETECT_URL="${MASTRA_AUTO_DETECT_URL:-true}"');
    expect(runtimeScript).toContain("export PORT MASTRA_AUTO_DETECT_URL");
    expect(packageJson.scripts.build).toContain("mastra worker build --dir src/mastra --output-dir .mastra/worker");
    expect(runtimeScript).toContain("exec node dist/worker-supervisor.mjs");
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

  it("uses Mastra's guarded lifecycle wrappers for local sandbox resources", async () => {
    const sources = await Promise.all([
      readFile(join(projectRoot, "src/sandbox/runtime.ts"), "utf8"),
      readFile(join(projectRoot, "src/sandbox/code-task-worker.ts"), "utf8"),
    ]);
    const combined = sources.join("\n");

    expect(combined).toContain("await sandbox._start()");
    expect(combined).toContain("await sandbox._destroy()");
    expect(combined).toContain("await filesystem._init()");
    expect(combined).toContain("await session.filesystem._destroy()");
    expect(combined).not.toMatch(/\b(?:filesystem|sandbox|taskSandbox|browserSandbox|checkSandbox)\.(?:start|destroy)\s*\(/u);
  });
});
