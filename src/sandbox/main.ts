import { QaseySandboxRuntime, sandboxRuntimeOptions } from "./runtime.ts";

const runtime = new QaseySandboxRuntime(sandboxRuntimeOptions());
const server = await runtime.start();
let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = server.close().then(() => {
    process.exitCode = 0;
  }, error => {
    process.exitCode = 1;
    console.error(JSON.stringify({
      event: "sandbox.shutdown.failed",
      signal,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  });
  return shutdownPromise;
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
