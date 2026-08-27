import pg from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = pg;

// Automatic adoption is safe only for a database that contains Mastra-owned
// tables but no pre-existing Qasey application table. CREATE TABLE IF NOT
// EXISTS cannot prove that an old table has every required column/constraint.
const applicationTables = [
  "agent_application_run_events",
  "agent_application_runs",
  "platform_api_tokens",
  "platform_audit_log",
  "platform_channel_deliveries",
  "platform_role_permissions",
  "platform_roles",
  "platform_slack_app_installations",
  "platform_subject_roles",
  "platform_trigger_bindings",
  "qasey_mcp_oauth_credentials",
  "qasey_sandbox_leases",
];

export async function assertAutomaticBaselineIsSafe(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required to verify baseline adoption");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [applicationTables],
    );
    if (result.rowCount) {
      throw new Error(
        "Automatic Prisma baseline adoption is disabled for a database with existing Qasey tables; perform a reviewed schema migration first",
      );
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  assertAutomaticBaselineIsSafe(process.env.DATABASE_URL).catch(error => {
    console.error(error instanceof Error ? error.message : "Baseline adoption verification failed");
    process.exitCode = 1;
  });
}
