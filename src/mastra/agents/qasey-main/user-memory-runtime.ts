import { Client } from "pg";
import { config } from "../../runtime.ts";
import { UserMemoryService, type UserMemoryLock } from "../../applications/qasey/user-memory.ts";
import { qaseyMemory } from "./memory.ts";

// A dedicated connection holds the cross-process lock while Mastra reads/writes
// its resource record. It cannot exhaust Mastra's pool or expire a transaction
// timer while a Memory API write is still in flight. No Mastra SQL schema access.
const withUserMemoryLock: UserMemoryLock = async (resourceId, work) => {
  const client = new Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("BEGIN");
    const { rows: [lock] } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [`qasey-user-memory:${resourceId}`],
    );
    if (!lock?.acquired) throw new Error("User memory is being updated in another conversation. Read it again and retry.");
    return await work();
  } finally {
    // Closing rolls back the lock-only transaction, releasing the advisory lock.
    // Memory writes use Mastra's connection and are already committed.
    await client.end();
  }
};

export const userMemoryService = qaseyMemory && config.DATABASE_URL
  ? new UserMemoryService(qaseyMemory, withUserMemoryLock)
  : undefined;

export function requireUserMemoryService() {
  if (!userMemoryService) throw new Error("Persistent user memory requires configured PostgreSQL storage");
  return userMemoryService;
}
