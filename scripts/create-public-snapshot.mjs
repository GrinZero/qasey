import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const projectRoot = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
const arguments_ = process.argv.slice(2).filter(argument => argument !== "--");
const targetArgument = arguments_.length === 1 ? arguments_[0] : undefined;

if (!targetArgument) {
  console.error("Usage: pnpm public:snapshot -- /absolute/path/to/new-public-repository");
  process.exit(64);
}
if (!isAbsolute(targetArgument)) {
  console.error("The public snapshot destination must be an absolute path.");
  process.exit(64);
}

const target = resolve(targetArgument);
let targetParent;
try {
  targetParent = realpathSync(dirname(target));
} catch {
  console.error("The public snapshot destination's parent directory must already exist.");
  process.exit(73);
}
const realTarget = resolve(targetParent, basename(target));
if (realTarget === projectRoot || realTarget.startsWith(`${projectRoot}${sep}`)) {
  console.error("The public snapshot destination must be outside the source repository.");
  process.exit(64);
}
if (existsSync(target)) {
  console.error(`Refusing to overwrite existing destination: ${target}`);
  process.exit(73);
}

execFileSync(process.execPath, [resolve(projectRoot, "scripts/check-open-source.mjs")], {
  cwd: projectRoot,
  stdio: "inherit",
});

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: projectRoot, encoding: "utf8" },
).split("\0").filter(Boolean);

mkdirSync(target, { recursive: false });
for (const file of files) {
  const source = resolve(projectRoot, file);
  if (!existsSync(source)) continue;
  const destination = resolve(target, file);
  if (relative(target, destination).startsWith(`..${sep}`)) throw new Error(`Unsafe repository path: ${file}`);
  const stat = lstatSync(source);
  mkdirSync(dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(source);
    if (isAbsolute(link) || resolve(dirname(source), link).startsWith(projectRoot + sep) === false) {
      throw new Error(`Refusing external symlink in public snapshot: ${file}`);
    }
    symlinkSync(link, destination);
  } else if (stat.isFile()) {
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode);
  }
}

writeFileSync(resolve(target, ".public-origin"), "qasey-sanitized-snapshot-v1\n", { mode: 0o644 });
execFileSync("git", ["init", "--initial-branch=main"], { cwd: target, stdio: "inherit" });
execFileSync("git", ["config", "user.name", "Qasey Release Bot"], { cwd: target });
execFileSync("git", ["config", "user.email", "release-bot@users.noreply.github.com"], { cwd: target });
execFileSync("git", ["add", "--all"], { cwd: target });
execFileSync(
  "git",
  ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial public release"],
  { cwd: target, stdio: "inherit" },
);
execFileSync(process.execPath, [resolve(target, "scripts/check-public-history.mjs")], {
  cwd: target,
  stdio: "inherit",
});

console.log(`Created sanitized one-root public repository at ${target}`);
