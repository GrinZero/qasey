import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat();
}

describe("Prisma application database", () => {
  it("declares every application-owned table in the Prisma schema and baseline migration", async () => {
    const [schema, migration] = await Promise.all([
      readFile(join(projectRoot, "prisma/schema.prisma"), "utf8"),
      readFile(join(projectRoot, "prisma/migrations/20260824133000_baseline_application_database/migration.sql"), "utf8"),
    ]);
    const tables = [
      "agent_application_runs",
      "agent_application_run_events",
      "platform_channel_deliveries",
      "platform_roles",
      "platform_role_permissions",
      "platform_subject_roles",
      "platform_audit_log",
      "platform_api_tokens",
      "platform_slack_app_installations",
      "platform_trigger_bindings",
      "qasey_sandbox_leases",
      "qasey_mcp_oauth_credentials",
    ];

    for (const table of tables) {
      expect(schema, `${table} is absent from schema.prisma`).toContain(`@@map("${table}")`);
      expect(migration, `${table} is absent from the baseline migration`).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
  });

  it("keeps DDL in migrations and deploys it before production processes start", async () => {
    const repositoryFiles = (await Promise.all([
      typescriptFiles(join(projectRoot, "src")),
      typescriptFiles(join(projectRoot, "packages")),
    ])).flat();
    const runtimeDdl: string[] = [];
    for (const file of repositoryFiles) {
      if ((await readFile(file, "utf8")).includes("CREATE TABLE")) runtimeDdl.push(relative(projectRoot, file));
    }
    expect(runtimeDdl).toEqual([]);

    const [runtime, packageJson] = await Promise.all([
      readFile(join(projectRoot, "ci/runtime.sh"), "utf8"),
      readFile(join(projectRoot, "package.json"), "utf8").then(JSON.parse) as Promise<{ scripts: Record<string, string> }>,
    ]);
    expect(packageJson.scripts["db:migrate:deploy"]).toBe("prisma migrate deploy");
    expect(runtime).toContain("pnpm db:migrate:deploy");
    expect(runtime.indexOf("migrate_database")).toBeLessThan(runtime.indexOf("exec node .mastra/output/index.mjs"));
    expect(runtime.indexOf("migrate_database")).toBeLessThan(runtime.indexOf("exec node .mastra/worker/index.mjs"));
  });
});
