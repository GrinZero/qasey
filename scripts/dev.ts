import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { acquireDevelopmentLock } from "./dev-lock.ts";

// Mastra recreates `.mastra` during startup, so the outer process lock must
// live in Qasey's own ignored runtime directory.
const lock = await acquireDevelopmentLock(resolve(".qasey/dev-runner.lock"));
let child: ChildProcess | undefined;
let forwardedSignal: NodeJS.Signals | undefined;

const forward = (signal: NodeJS.Signals): void => {
  if (forwardedSignal || !child?.pid) return;
  forwardedSignal = signal;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
const onSigint = (): void => forward("SIGINT");
const onSigterm = (): void => forward("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

async function run(command: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child?.once("spawn", resolveSpawn);
    child?.once("error", rejectSpawn);
  });
  await lock.setChildPid(child.pid!);
  return new Promise(resolveExit => {
    child?.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function exitCode(result: { code: number | null; signal: NodeJS.Signals | null }): number {
  return result.code ?? (result.signal === "SIGINT" ? 130 : 143);
}

try {
  const adminBuild = await run("pnpm", ["admin-ui:build"]);
  if (adminBuild.code !== 0) {
    process.exitCode = exitCode(adminBuild);
  } else {
    forwardedSignal = undefined;
    const runtime = await run("moego-aws-secret-env", [
      "run",
      "--default-environment",
      "testing",
      "--",
      "mastra",
      "dev",
      "--dir",
      "src/mastra",
    ]);
    process.exitCode = exitCode(runtime);
  }
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  await lock.release();
}
