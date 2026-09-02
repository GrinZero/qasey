import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const forbidden = [
  "@mastra/acp",
  "@agentclientprotocol",
  "codex-acp",
  "MastraAcpCodexBackend",
  "QASEY_ACP_",
  "mastraAcpVersion",
  "codexAcpVersion",
  "@openai/codex",
  "CODEX_HOME",
];
const roots = ["src/", "packages/", "apps/", "scripts/", "tests/", "config/"];
const exact = new Set(["package.json", "pnpm-lock.yaml", "skills-lock.json", "Dockerfile"]);
const self = "scripts/check-native-code-task.mjs";
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter(path => path !== self && (exact.has(path) || roots.some(root => path.startsWith(root))))
  .filter(path => !path.includes("/.mastra/") && !path.includes("/node_modules/") && !path.includes("/dist/"));
const findings = [];

for (const path of files) {
  if (!existsSync(path) || !statSync(path).isFile()) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const marker of forbidden) if (text.includes(marker)) findings.push(`${path}: ${marker}`);
}

if (findings.length > 0) {
  console.error("Native CodeTask boundary check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`Native CodeTask boundary check passed for ${files.length} tracked worktree files.`);
