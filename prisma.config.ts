import "./src/load-env.ts";
import { defineConfig } from "prisma/config";

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PG_URL;
  const port = process.env.PG_PORT;
  const username = process.env.PG_QASEY_USER_NAME;
  const password = process.env.PG_QASEY_PASSWORD;
  if (!host || !port || !username || !password) return "postgresql://unused:unused@localhost:5432/qasey";
  const url = new URL(host.includes("://") ? host : `postgresql://${host}`);
  url.protocol = "postgresql:";
  url.username = username;
  url.password = password;
  url.port = port;
  url.pathname = `/${process.env.PG_QASEY_DATABASE_NAME?.trim() || "qasey"}`;
  return url.toString();
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl() },
});
