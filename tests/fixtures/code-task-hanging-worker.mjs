import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const manifestPath = process.argv[2];
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await rm(manifestPath, { force: true });
const credentials = JSON.parse(await readJsonLine());
process.stdin.destroy();
const now = new Date().toISOString();
await mkdir(dirname(manifest.statePath), { recursive: true });
const temporaryStatePath = `${manifest.statePath}.${process.pid}.tmp`;
await writeFile(temporaryStatePath, JSON.stringify({
  taskId: manifest.spec.taskId,
  attemptId: manifest.spec.attemptId,
  status: "running",
  createdAt: now,
  updatedAt: now,
}), { mode: 0o600 });
await rename(temporaryStatePath, manifest.statePath);
await appendFile(manifest.eventsPath, `${JSON.stringify({
  cursor: "1",
  taskId: manifest.spec.taskId,
  at: now,
  type: "task.started",
  message: "fixture worker started",
  metadata: { attemptId: manifest.spec.attemptId },
})}\n`);
await mkdir(manifest.artifactRoot, { recursive: true });
if (manifest.spec.taskId.startsWith("terminal-delay")) {
  await writeFile(join(manifest.artifactRoot, "delayed-terminal.txt"), "terminal artifact\n", { mode: 0o600 });
  const terminalAt = new Date().toISOString();
  const terminalStatePath = `${manifest.statePath}.${process.pid}.terminal.tmp`;
  await writeFile(terminalStatePath, JSON.stringify({
    taskId: manifest.spec.taskId,
    attemptId: manifest.spec.attemptId,
    status: "failed",
    createdAt: now,
    updatedAt: terminalAt,
    error: "fixture terminal state before process exit",
  }), { mode: 0o600 });
  await rename(terminalStatePath, manifest.statePath);
  await appendFile(manifest.eventsPath, `${JSON.stringify({
    cursor: "2",
    taskId: manifest.spec.taskId,
    at: terminalAt,
    type: "task.completed",
    message: "fixture wrote terminal state before exit",
    metadata: { attemptId: manifest.spec.attemptId, status: "failed" },
  })}\n`);
  await new Promise(resolveWait => setTimeout(resolveWait, 1_500));
} else {
  const child = spawn("sh", ["-c", "sleep 300"], { stdio: "ignore" });
  await writeFile(join(manifest.artifactRoot, "child.pid"), String(child.pid));
  await writeFile(join(manifest.artifactRoot, "credential-presence.json"), JSON.stringify({
    modelInInitialEnvironment: Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL),
    modelReceivedInMemory: Boolean(credentials.openaiApiKey),
    modelCanaryInWorkerOrChildProc: [process.pid, child.pid].some(pid => procEnvironment(pid).includes(credentials.openaiApiKey ?? "never-match-empty-credential")),
    github: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GIT_CONFIG_VALUE_0),
    controlPlane: Boolean(process.env.QASEY_DEV_AUTH_TOKEN || process.env.DATABASE_URL || process.env.METERSPHERE_API_TOKEN),
    repositoryBroker: Boolean(process.env.QASEY_GH_BROKER_URL || process.env.QASEY_GH_BROKER_TOKEN),
  }));
  await symlink("/etc/hosts", join(manifest.artifactRoot, "escaping-link"));
  setInterval(() => undefined, 60_000);
}

function readJsonLine() {
  return new Promise((resolveLine, reject) => {
    let buffered = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      process.stdin.pause();
      resolveLine(buffered.slice(0, newline));
    });
    process.stdin.once("error", reject);
  });
}

function procEnvironment(pid) {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8"); }
  catch { return ""; }
}
