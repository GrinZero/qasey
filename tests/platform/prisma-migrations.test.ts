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
  it("loads the generated client with every runtime dependency available at the application root", async () => {
    const packageJson = await readFile(join(projectRoot, "package.json"), "utf8")
      .then(JSON.parse) as { dependencies: Record<string, string> };

    expect(packageJson.dependencies["@prisma/client-runtime-utils"]).toBe(packageJson.dependencies["@prisma/client"]);
    await expect(import("@prisma/client")).resolves.toBeDefined();
  });

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
    expect(migration).toContain("left(table_name, 7) = 'mastra_'");
    expect(migration).toContain("Refusing to baseline a non-empty schema without recognized Qasey or Mastra tables");
  });

  it("keeps DDL in migrations and exposes one distributed pre-deploy migration role", async () => {
    const repositoryFiles = (await Promise.all([
      typescriptFiles(join(projectRoot, "src")),
      typescriptFiles(join(projectRoot, "packages")),
    ])).flat();
    const runtimeDdl: string[] = [];
    for (const file of repositoryFiles) {
      if ((await readFile(file, "utf8")).includes("CREATE TABLE")) runtimeDdl.push(relative(projectRoot, file));
    }
    expect(runtimeDdl).toEqual([]);

    const [runtime, migrationRuntime, adoptionVerifier, packageJson] = await Promise.all([
      readFile(join(projectRoot, "ci/runtime.sh"), "utf8"),
      readFile(join(projectRoot, "ci/migrate-database.sh"), "utf8"),
      readFile(join(projectRoot, "ci/verify-baseline-adoption.mjs"), "utf8"),
      readFile(join(projectRoot, "package.json"), "utf8").then(JSON.parse) as Promise<{ scripts: Record<string, string> }>,
    ]);
    expect(packageJson.scripts["db:migrate:deploy"]).toBe("prisma migrate deploy");
    expect(runtime).toContain("sh ci/migrate-database.sh");
    expect(migrationRuntime).toContain('node "$prisma_cli" migrate deploy');
    expect(migrationRuntime).toContain("*P3005*)");
    expect(migrationRuntime).toContain("node ci/verify-baseline-adoption.mjs");
    expect(migrationRuntime).toContain('db execute --file "$baseline_sql"');
    expect(migrationRuntime).toContain('migrate resolve --applied "$baseline_name"');
    expect(migrationRuntime).not.toContain("pnpm");
    expect(adoptionVerifier).toContain("information_schema.tables");
    expect(adoptionVerifier).toContain("existing Qasey tables");
    expect(adoptionVerifier).not.toContain("DATABASE_URL=");
    expect(runtime).toContain("run_predeploy_migration");
    expect(runtime).toContain("migrate)");
    expect(runtime).toContain('if [ "${QASEY_DEPLOYMENT_MODE:-standalone}" = "distributed" ]');
    expect(runtime).toContain('configuration_error "DATABASE_URL is required for the migration role"');
  });

  it("keeps post-baseline migrations expand-only for N/N-1 rolling compatibility", async () => {
    const migrationRoot = join(projectRoot, "prisma/migrations");
    const directories = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("20260824133000_"));
    const destructiveDdl = /\b(?:DROP\s+(?:TABLE|COLUMN)|RENAME\s+(?:TABLE|COLUMN)|ALTER\s+COLUMN[\s\S]{0,120}\b(?:TYPE|SET\s+NOT\s+NULL))\b/iu;
    for (const directory of directories) {
      const migration = await readFile(join(migrationRoot, directory.name, "migration.sql"), "utf8");
      expect(migration, `${directory.name} contains contract-phase DDL`).not.toMatch(destructiveDdl);
    }
  });

  it("adds an independent optimistic revision to application runs", async () => {
    const [schema, migration] = await Promise.all([
      readFile(join(projectRoot, "prisma/schema.prisma"), "utf8"),
      readFile(join(projectRoot, "prisma/migrations/20260826143000_add_agent_run_revision/migration.sql"), "utf8"),
    ]);

    expect(schema).toMatch(/model AgentApplicationRun \{[\s\S]*?revision\s+Int\s+@default\(1\)/u);
    expect(migration).toContain('ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1');
  });

  it("persists expiring, revocable organization invitations without domain-derived membership", async () => {
    const [schema, migration] = await Promise.all([
      readFile(join(projectRoot, "prisma/schema.prisma"), "utf8"),
      readFile(join(projectRoot, "prisma/migrations/20260826160000_add_organization_invitations/migration.sql"), "utf8"),
    ]);

    expect(schema).toContain("model PlatformOrganizationInvitation {");
    expect(migration).toContain('CREATE TABLE "platform_organization_invitations"');
    expect(migration).toContain('CHECK ("email" = lower("email"))');
    expect(migration).toContain('CHECK ("expires_at" > "created_at")');
    expect(migration).toContain('CREATE UNIQUE INDEX "platform_organization_invitations_pending_email_key"');
    expect(migration).toContain('WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL');
    expect(migration).toContain('FOREIGN KEY ("organization_id")');
    expect(migration).toContain('FOREIGN KEY ("accepted_by_user_id")');
    expect(migration).not.toMatch(/platform_organization_domains[\s\S]*INSERT INTO "platform_organization_memberships"/u);
  });

  it("stores versioned password hashes in a user-bound credential table", async () => {
    const [schema, migration] = await Promise.all([
      readFile(join(projectRoot, "prisma/schema.prisma"), "utf8"),
      readFile(join(projectRoot, "prisma/migrations/20260827090000_add_password_authentication/migration.sql"), "utf8"),
    ]);

    expect(schema).toContain("model PlatformPasswordCredential {");
    expect(schema).toContain('@@map("platform_password_credentials")');
    expect(migration).toContain('CREATE TABLE "platform_password_credentials"');
    expect(migration).toContain('CHECK (char_length("password_hash") BETWEEN 32 AND 1024)');
    expect(migration).toContain('REFERENCES "platform_users"("id") ON DELETE CASCADE');
    expect(migration).not.toMatch(/\b(?:password|secret)\s+TEXT\b/iu);
  });
});
