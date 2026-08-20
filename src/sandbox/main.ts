import { QaseySandboxRuntime, sandboxRuntimeOptions } from "./runtime.ts";

const runtime = new QaseySandboxRuntime(sandboxRuntimeOptions());
const server = await runtime.start();

async function shutdown(): Promise<void> {
  await server.close();
  process.exitCode = 0;
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

