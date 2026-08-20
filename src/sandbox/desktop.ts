import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface DesktopToolResult {
  text: string;
  images: Array<{ mimeType: string; dataBase64: string }>;
  structuredJson?: string;
  isError: boolean;
  errorCode?: string;
  degraded: boolean;
  rawJson: string;
}

export interface DesktopControllerOptions {
  display: number;
  width: number;
  height: number;
  root: string;
  home: string;
  runtimeDirectory: string;
  driverWorkerPath: string;
}

export class DesktopController {
  private readonly children: ChildProcess[] = [];
  private readonly applications = new Set<ChildProcess>();
  private readonly pending = new Map<number, { resolve(value: DesktopToolResult): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private worker?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private closed = false;
  private dbusPid?: number;
  private stderrTail = "";
  readonly environment: NodeJS.ProcessEnv;

  constructor(readonly options: DesktopControllerOptions) {
    this.environment = {
      ...process.env,
      DISPLAY: `:${options.display}`,
      HOME: options.home,
      XDG_RUNTIME_DIR: options.runtimeDirectory,
      XDG_CONFIG_HOME: join(options.home, ".config"),
      XDG_CACHE_HOME: join(options.home, ".cache"),
      XDG_DATA_HOME: join(options.home, ".local", "share"),
      GDK_BACKEND: "x11",
      QT_QPA_PLATFORM: "xcb",
      NO_AT_BRIDGE: "0",
    };
  }

  async start(): Promise<void> {
    const runtimeDirectory = this.environment.XDG_RUNTIME_DIR;
    if (!runtimeDirectory) throw new Error("Desktop runtime directory is unavailable");
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(runtimeDirectory, 0o700);

    await Promise.all([
      rm(`/tmp/.X11-unix/X${this.options.display}`, { force: true }),
      rm(`/tmp/.X${this.options.display}-lock`, { force: true }),
    ]);
    const xvfb = this.spawn("Xvfb", [
      `:${this.options.display}`,
      "-screen", "0", `${this.options.width}x${this.options.height}x24`,
      "-nolisten", "tcp", "-ac", "+extension", "RANDR", "+render", "-noreset",
    ]);
    await waitForPath(`/tmp/.X11-unix/X${this.options.display}`, xvfb, 10_000);

    const dbus = await runCapture("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], this.environment);
    const [address, pidText] = dbus.stdout.trim().split(/\r?\n/u);
    if (!address || !pidText || !Number.isInteger(Number(pidText))) throw new Error(`Unable to start session DBus: ${dbus.stderr || dbus.stdout}`);
    this.dbusPid = Number(pidText);
    this.environment.DBUS_SESSION_BUS_ADDRESS = address;

    this.spawn("openbox", ["--sm-disable"]);
    this.worker = this.spawn(process.execPath, [this.options.driverWorkerPath]) as ChildProcessWithoutNullStreams;
    const lines = createInterface({ input: this.worker.stdout, crlfDelay: Infinity });
    lines.on("line", line => this.receive(line));
    this.worker.stderr.on("data", chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_000);
    });
    this.worker.once("exit", (code, signal) => {
      const reason = new Error(`Cua Driver worker stopped (${signal ?? code ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(reason);
      }
      this.pending.clear();
      delete this.worker;
    });

    const report = await this.call("health_report", {});
    if (report.isError) throw new Error(report.text || report.errorCode || "Cua Driver health check failed");
  }

  async call(tool: string, argumentsJson: Record<string, unknown>, timeoutMs = 30_000): Promise<DesktopToolResult> {
    const worker = this.worker;
    if (!worker || this.closed) throw new Error("Desktop is not running");
    const id = this.nextRequestId++;
    return await new Promise<DesktopToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cua Driver tool timed out: ${tool}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      worker.stdin.write(`${JSON.stringify({ id, tool, arguments: argumentsJson })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  launch(command: string, args: string[] = [], options: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess {
    const child = this.spawn(command, args, options);
    this.applications.add(child);
    child.once("exit", () => this.applications.delete(child));
    return child;
  }

  async resetApplications(): Promise<void> {
    for (const child of this.applications) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await Promise.allSettled([...this.applications].map(child => waitForExit(child, 2_000)));
    this.applications.clear();
    await this.call("clipboard_write", { text: "" }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.resetApplications();
    if (this.worker) {
      this.worker.kill("SIGTERM");
      await waitForExit(this.worker, 3_000);
    }
    for (const child of this.children.toReversed()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await Promise.allSettled(this.children.map(child => waitForExit(child, 1_000)));
    if (this.dbusPid) {
      try { process.kill(this.dbusPid, "SIGTERM"); } catch { /* already stopped */ }
    }
    await rm(this.environment.XDG_RUNTIME_DIR ?? "", { recursive: true, force: true }).catch(() => undefined);
  }

  private spawn(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
    const child = spawn(command, args, {
      cwd: options.cwd ?? this.options.root,
      env: { ...this.environment, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    this.children.push(child);
    return child;
  }

  private receive(line: string): void {
    try {
      const message = JSON.parse(line) as { id: number; result?: DesktopToolResult; error?: string };
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else if (message.result) pending.resolve(message.result);
      else pending.reject(new Error("Cua Driver returned an empty response"));
    } catch {
      this.stderrTail = `${this.stderrTail}\nInvalid Cua Driver response: ${line}`.slice(-4_000);
    }
  }
}

async function waitForPath(path: string, processHandle: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error(`Desktop display stopped before becoming ready: ${path}`);
    try { await access(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error(`Timed out waiting for desktop display: ${path}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function runCapture(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited with ${code}: ${stderr}`)));
  });
}
