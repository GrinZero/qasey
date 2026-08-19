import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { acquireDevelopmentLock } from "./dev-lock.ts";

const lock = await acquireDevelopmentLock(resolve(".mastra/dev.lock"));
let child;

try {
  child = spawn("moego-aws-secret-env", [
    "run",
    "--default-environment",
    "testing",
    "--",
    "mastra",
    "dev",
    "--dir",
    "src/mastra",
  ], {
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child!.once("spawn", resolveSpawn);
    child!.once("error", rejectSpawn);
  });
  await lock.setChildPid(child.pid!);

  let forwardedSignal: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    if (process.platform === "win32") child!.kill(signal);
    else process.kill(-child!.pid!, signal);
  };
  const onSigint = (): void => forward("SIGINT");
  const onSigterm = (): void => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child!.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 143);
} finally {
  await lock.release();
}
