import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const self = "scripts/check-open-source.mjs";
const brand = ["moe", "go"].join("");
const organizationRepositoryMarkers = [
  ["B", "Web"].join(""),
  ["O", "BC"].join(""),
];
const checks = [
  { name: "legacy organization reference", pattern: new RegExp(brand, "iu") },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/u },
  { name: "OpenAI-style secret key", pattern: /sk-[A-Za-z0-9_-]{20,}/u },
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/u },
  { name: "GitHub token", pattern: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/u },
  { name: "Google API key", pattern: /AIza[0-9A-Za-z_-]{30,}/u },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: "private endpoint hostname", pattern: /(?:https?|postgres(?:ql)?):\/\/[^\s"'`<>()]*\.(?:internal|corp)(?=[:/\s"'`<>()]|$)/iu },
  ...organizationRepositoryMarkers.map(marker => ({
    name: "legacy organization repository convention",
    pattern: new RegExp(`\\b${marker}\\b`, "u"),
  })),
];

const forbiddenRuntimePaths = new Set([
  "config/e2e-repository.json",
  "config/mcp.json",
]);

function isForbiddenRuntimePath(file) {
  if (forbiddenRuntimePaths.has(file)) return true;
  const name = basename(file);
  if (!name.startsWith(".env")) return false;
  return name !== ".env.example" && !name.endsWith(".example");
}

function hasNonLocalUrlCredential(text) {
  const urls = text.match(/(?:https?|postgres(?:ql)?):\/\/[^\s"'`<>()]+/gu) ?? [];
  return urls.some(raw => {
    try {
      const url = new URL(raw.replace(/[.,;:]$/u, ""));
      const synthetic = url.hostname === "localhost"
        || url.hostname === "127.0.0.1"
        || url.hostname === "::1"
        || url.hostname.endsWith(".example.com");
      return !synthetic && Boolean(url.username || url.password);
    } catch {
      return false;
    }
  });
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter(file => file !== self);
const failures = [];

for (const file of files) {
  if (!existsSync(file)) continue;
  if (new RegExp(brand, "iu").test(file)) failures.push(`${file}: legacy organization reference in path`);
  if (isForbiddenRuntimePath(file)) {
    failures.push(`${file}: runtime configuration must not be tracked`);
  }
  if (!lstatSync(file).isFile()) continue;
  const value = readFileSync(file);
  if (value.includes(0)) continue;
  const text = value.toString("utf8");
  for (const check of checks) {
    if (check.pattern.test(text)) failures.push(`${file}: ${check.name}`);
  }
  if (hasNonLocalUrlCredential(text)) failures.push(`${file}: non-local URL embeds credentials`);
}

if (failures.length > 0) {
  console.error(`Open-source boundary check failed (${failures.length} findings):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Open-source boundary check passed for ${files.length} worktree files.`);
