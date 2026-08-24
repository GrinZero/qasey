import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

export interface ApplicationDatabase {
  client: PrismaClient;
  init(): Promise<void>;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export function createApplicationDatabase(connectionString: string): ApplicationDatabase {
  const adapter = new PrismaPg({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  const client = new PrismaClient({ adapter });
  let connected: Promise<void> | undefined;
  return {
    client,
    init() {
      connected ??= client.$connect();
      return connected;
    },
    async healthCheck() {
      if (!connected) throw new Error("Application database has not been initialized");
      await connected;
      await client.$queryRaw`SELECT 1`;
    },
    async close() {
      await client.$disconnect();
    },
  };
}
