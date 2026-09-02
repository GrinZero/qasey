import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import "../src/load-env.ts";
import { acquireDevelopmentLock } from "./dev-lock.ts";

const arguments_ = process.argv.slice(2);
const unknownArguments = arguments_.filter(argument => argument !== "--external-sandbox");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown development argument: ${unknownArguments.join(", ")}`);
}
const externalSandbox = arguments_.includes("--external-sandbox");

// Mastra recreates `.mastra` during startup, so the outer process lock must
// live in Qasey's own ignored runtime directory.
const lockPath = resolve(".qasey/dev-runner.lock");
const lock = await acquireDevelopmentLock(lockPath);
const children = new Set<ChildProcess>();
let forwardedSignal: NodeJS.Signals | undefined;

// Package-manager wrappers may terminate the tsx process immediately after a
// terminal signal. Keep a synchronous ownership-checked cleanup as the final
// backstop for the async finally block below.
const removeOwnedLockOnExit = (): void => {
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as { ownerPid?: number };
    if (record.ownerPid === process.pid) rmSync(lockPath, { force: true });
  } catch {
    // The async release path already removed it, or the record is incomplete.
  }
};
process.once("exit", removeOwnedLockOnExit);

const localSandboxPort = 4120;
// The local control plane and Sandbox share ephemeral process-scoped keys.
// They are deliberately not written to an .env file or inherited by task
// commands; restarting the development stack invalidates old capabilities.
const localSandboxControlKey = randomBytes(32).toString("base64url");
const localSandboxLeaseKey = randomBytes(32).toString("base64url");
const developmentEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "development",
  ...(externalSandbox
    ? {
        QASEY_SANDBOX_ENDPOINT_TEMPLATE: process.env.QASEY_SANDBOX_ENDPOINT_TEMPLATE ?? "http://sandbox-{ordinal}:4120",
        QASEY_SANDBOX_REPLICAS: process.env.QASEY_SANDBOX_REPLICAS ?? "1",
        QASEY_SANDBOX_MAX_SESSIONS: process.env.QASEY_SANDBOX_MAX_SESSIONS ?? "1",
      }
    : {
        QASEY_DATA_ROOT: resolve(".qasey/local-sandbox"),
        QASEY_SANDBOX_ENDPOINT_TEMPLATE: "http://127.0.0.1:412{ordinal}",
        QASEY_SANDBOX_PORT: String(localSandboxPort),
        QASEY_SANDBOX_REPLICAS: "1",
        QASEY_SANDBOX_MAX_SESSIONS: "1",
        QASEY_SANDBOX_DESKTOP_ENABLED: "false",
        QASEY_SANDBOX_CONTROL_KEY: localSandboxControlKey,
        QASEY_SANDBOX_LEASE_KEY: localSandboxLeaseKey,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? defaultPlaywrightBrowsersPath(),
      }),
};

function defaultPlaywrightBrowsersPath(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "ms-playwright");
  return join(homedir(), ".cache", "ms-playwright");
}

function spawnChild(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    detached: process.platform !== "win32",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawnChild(command, args, env);
  await waitForSpawn(child);
  await lock.setChildPid(child.pid!);
  return waitForExit(child);
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function forward(signal: NodeJS.Signals): void {
  if (forwardedSignal) return;
  forwardedSignal = signal;
  for (const child of children) signalChild(child, signal);
}

async function stopChildren(signal: NodeJS.Signals): Promise<void> {
  const active = [...children].filter(child => child.exitCode === null && child.signalCode === null);
  for (const child of active) signalChild(child, signal);
  if (active.length === 0) return;
  await Promise.race([
    Promise.all(active.map(waitForExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
  ]);
  const remaining = active.filter(child => child.exitCode === null && child.signalCode === null);
  for (const child of remaining) signalChild(child, "SIGKILL");
  await Promise.all(remaining.map(waitForExit));
}

const onSigint = (): void => forward("SIGINT");
const onSigterm = (): void => forward("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

function exitCode(result: { code: number | null; signal: NodeJS.Signals | null }): number {
  return result.code ?? (result.signal === "SIGINT" ? 130 : 143);
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

async function waitForSandboxReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  const url = `http://127.0.0.1:${localSandboxPort}/readyz`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Local Sandbox exited before becoming ready (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The runtime has not bound the port yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`Local Sandbox did not become ready at ${url}`);
}

try {
  const adminBuild = await run("pnpm", ["admin-ui:build"]);
  if (adminBuild.code !== 0) {
    process.exitCode = exitCode(adminBuild);
  } else if (externalSandbox) {
    forwardedSignal = undefined;
    const mastra = spawnChild("pnpm", [
      "exec",
      "mastra",
      "dev",
      "--dir",
      "src/mastra",
      "--env",
      ".devcontainer/mastra.env",
    ], developmentEnv);
    await waitForSpawn(mastra);
    await lock.setChildPid(mastra.pid!);
    const result = await waitForExit(mastra);
    process.exitCode = forwardedSignal ? signalExitCode(forwardedSignal) : exitCode(result) || 1;
  } else {
    const runtimeBuild = await run("pnpm", ["exec", "tsup"]);
    if (runtimeBuild.code !== 0) {
      process.exitCode = exitCode(runtimeBuild);
    } else {
      const browserInstall = await run("pnpm", ["exec", "playwright", "install", "chromium"], developmentEnv);
      if (browserInstall.code !== 0) {
        process.exitCode = exitCode(browserInstall);
      } else {
        forwardedSignal = undefined;
        const sandbox = spawnChild(process.execPath, ["dist/sandbox-runtime.mjs"], developmentEnv);
        await waitForSpawn(sandbox);
        await lock.setChildPid(sandbox.pid!);
        await waitForSandboxReady(sandbox);

        const mastra = spawnChild("pnpm", ["exec", "mastra", "dev", "--dir", "src/mastra"], developmentEnv);
        await waitForSpawn(mastra);
        await lock.setChildPid(mastra.pid!);

        const firstExit = await Promise.race([waitForExit(sandbox), waitForExit(mastra)]);
        await stopChildren(forwardedSignal ?? "SIGTERM");
        process.exitCode = forwardedSignal ? signalExitCode(forwardedSignal) : exitCode(firstExit) || 1;
      }
    }
  }
} catch (error) {
  if (!forwardedSignal) throw error;
  process.exitCode = signalExitCode(forwardedSignal);
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  await stopChildren(forwardedSignal ?? "SIGTERM");
  await lock.release();
}
