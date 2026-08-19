import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDevelopmentLock } from "../../scripts/dev-lock.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qasey-dev-lock-"));
  temporaryDirectories.push(directory);
  return join(directory, "dev.lock");
}

describe("development server lock", () => {
  it("rejects a second live dev server", async () => {
    const lockPath = await temporaryLockPath();
    const first = await acquireDevelopmentLock(lockPath, { ownerPid: 101, processExists: pid => pid === 101 });

    await expect(acquireDevelopmentLock(lockPath, {
      ownerPid: 202,
      processExists: pid => pid === 101,
    })).rejects.toThrow("already running (PID 101)");

    await first.release();
  });

  it("recovers a stale lock and preserves a newer owner's lock on release", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, JSON.stringify({ ownerPid: 99, childPid: 100, cwd: "/old", startedAt: "old" }));
    const lock = await acquireDevelopmentLock(lockPath, {
      ownerPid: 303,
      cwd: "/current",
      processExists: () => false,
    });
    await lock.setChildPid(304);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ ownerPid: 303, childPid: 304 });

    await writeFile(lockPath, JSON.stringify({ ownerPid: 404, cwd: "/new", startedAt: "new" }));
    await lock.release();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ ownerPid: 404 });
  });
});
