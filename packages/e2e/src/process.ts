import { spawn } from "node:child_process";

export interface SafeCommand {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runSafeCommand(command: SafeCommand): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      shell: false,
      env: { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8", ...command.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const max = 2_000_000;
    child.stdout.on("data", chunk => { if (stdout.length < max) stdout += String(chunk); });
    child.stderr.on("data", chunk => { if (stderr.length < max) stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), command.timeoutMs ?? 300_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

