import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

interface DevelopmentLockRecord {
  ownerPid: number;
  childPid?: number;
  cwd: string;
  startedAt: string;
}

type ProcessExists = (pid: number) => boolean;

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readRecord(lockPath: string): Promise<DevelopmentLockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<DevelopmentLockRecord>;
    if (!Number.isInteger(value.ownerPid) || typeof value.cwd !== "string") return undefined;
    return value as DevelopmentLockRecord;
  } catch {
    return undefined;
  }
}

export class DevelopmentLock {
  private released = false;

  constructor(
    private readonly lockPath: string,
    private readonly handle: FileHandle,
    private record: DevelopmentLockRecord,
  ) {}

  async setChildPid(childPid: number): Promise<void> {
    this.record = { ...this.record, childPid };
    await this.handle.truncate(0);
    await this.handle.write(JSON.stringify(this.record), 0, "utf8");
    await this.handle.sync();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.handle.close();
    const current = await readRecord(this.lockPath);
    if (current?.ownerPid === this.record.ownerPid) {
      await rm(this.lockPath, { force: true });
    }
  }
}

export async function acquireDevelopmentLock(
  lockPath: string,
  options: { ownerPid?: number; cwd?: string; processExists?: ProcessExists } = {},
): Promise<DevelopmentLock> {
  const ownerPid = options.ownerPid ?? process.pid;
  const cwd = options.cwd ?? process.cwd();
  const processExists = options.processExists ?? defaultProcessExists;
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      const record = { ownerPid, cwd, startedAt: new Date().toISOString() } satisfies DevelopmentLockRecord;
      await handle.write(JSON.stringify(record), 0, "utf8");
      await handle.sync();
      return new DevelopmentLock(lockPath, handle, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing = await readRecord(lockPath);
      if (!existing) {
        await new Promise(resolve => setTimeout(resolve, 100));
        existing = await readRecord(lockPath);
      }
      const ownerAlive = existing ? processExists(existing.ownerPid) : true;
      const childAlive = existing?.childPid ? processExists(existing.childPid) : false;
      if (ownerAlive || childAlive) {
        const pid = childAlive ? existing?.childPid : existing?.ownerPid;
        throw new Error(`A Qasey dev server is already running${pid ? ` (PID ${pid})` : ""}. Stop it before starting another instance.`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("Unable to acquire the Qasey development server lock.");
}
