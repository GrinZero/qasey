import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const manifestPath = process.argv[2];
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await rm(manifestPath, { force: true });
const now = new Date().toISOString();
await mkdir(dirname(manifest.statePath), { recursive: true });
await writeFile(manifest.statePath, JSON.stringify({
  taskId: manifest.spec.taskId,
  attemptId: manifest.spec.attemptId,
  status: "running",
  createdAt: now,
  updatedAt: now,
}));
await appendFile(manifest.eventsPath, `${JSON.stringify({
  cursor: "1",
  taskId: manifest.spec.taskId,
  at: now,
  type: "task.started",
  message: "fixture worker started",
  metadata: { attemptId: manifest.spec.attemptId },
})}\n`);
const child = spawn("sh", ["-c", "sleep 300"], { stdio: "ignore" });
await writeFile(join(manifest.taskRoot, "child.pid"), String(child.pid));
await writeFile(join(manifest.taskRoot, "credential-presence.json"), JSON.stringify({
  model: Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY),
  github: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GIT_CONFIG_VALUE_0),
  controlPlane: Boolean(process.env.QASEY_DEV_AUTH_TOKEN || process.env.DATABASE_URL || process.env.METERSPHERE_API_TOKEN),
}));
setInterval(() => undefined, 60_000);
