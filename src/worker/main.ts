import { resolve } from "node:path";
import { WorkerSupervisor, workerSupervisorOptions } from "./supervisor.ts";

const workerEntry = process.env.QASEY_WORKER_ENTRY?.trim()
  || resolve(process.cwd(), ".mastra/worker/index.mjs");
const supervisor = new WorkerSupervisor(workerSupervisorOptions(workerEntry));
const handle = await supervisor.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await handle.close();
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
process.exitCode = await handle.wait();
await shutdown();
