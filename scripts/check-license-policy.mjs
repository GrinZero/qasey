import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const SUPPORTED_REVIEW_KEY = "@mastra/redis-streams@0.3.0";
const REVIEW_FIELDS = [
  "expectedLicense",
  "licenseFile",
  "licenseSha256",
  "name",
  "pnpmLockIntegrity",
  "repository",
  "version",
];

const ALLOWED_LICENSES = new Set(
  [
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BlueOak-1.0.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "MPL-2.0",
    "Python-2.0",
    "Unlicense",
  ].map((license) => license.toUpperCase()),
);

// These identifiers are understood but are not accepted by this policy. An OR
// expression may still select a separately allowed license.
const KNOWN_REJECTED_LICENSES = new Set(["AFL-2.1", "WTFPL"]);
const KNOWN_REJECTED_PATTERN =
  /^(?:AGPL|BUSL|CDDL|COMMONS-CLAUSE|CPAL|ELASTIC|EPL|EUPL|GPL|LGPL|MS-RL|OSL|RPL|SPL|SSPL)(?:[-+.].*)?$/u;
const FAIL_CLOSED_IDENTIFIERS = new Set([
  "NONE",
  "NOASSERTION",
  "UNKNOWN",
  "UNLICENSED",
]);

function tokenize(expression) {
  const tokens = [];
  let cursor = 0;

  while (cursor < expression.length) {
    const whitespace = /^\s+/u.exec(expression.slice(cursor));
    if (whitespace) {
      cursor += whitespace[0].length;
      continue;
    }

    const character = expression[cursor];
    if (character === "(" || character === ")") {
      tokens.push(character);
      cursor += 1;
      continue;
    }

    const identifier = /^[A-Za-z0-9][A-Za-z0-9.+-]*/u.exec(expression.slice(cursor));
    if (!identifier) {
      throw new Error("unsupported token");
    }

    const value = identifier[0];
    const operator = value.toUpperCase();
    tokens.push(operator === "AND" || operator === "OR" || operator === "WITH" ? operator : value);
    cursor += value.length;
  }

  return tokens;
}

function parseExpression(expression) {
  const tokens = tokenize(expression);
  let cursor = 0;

  function parsePrimary() {
    const token = tokens[cursor];
    if (token === "(") {
      cursor += 1;
      const node = parseOr();
      if (tokens[cursor] !== ")") {
        throw new Error("unclosed parenthesis");
      }
      cursor += 1;
      return node;
    }

    if (!token || token === ")" || token === "AND" || token === "OR" || token === "WITH") {
      throw new Error("expected license identifier");
    }
    cursor += 1;
    return { type: "identifier", value: token };
  }

  function parseWith() {
    let node = parsePrimary();
    if (tokens[cursor] === "WITH") {
      cursor += 1;
      node = { type: "with", license: node, exception: parsePrimary() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseWith();
    while (tokens[cursor] === "AND") {
      cursor += 1;
      node = { type: "and", left: node, right: parseWith() };
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (tokens[cursor] === "OR") {
      cursor += 1;
      node = { type: "or", left: node, right: parseAnd() };
    }
    return node;
  }

  if (tokens.length === 0) {
    throw new Error("empty expression");
  }
  const root = parseOr();
  if (cursor !== tokens.length) {
    throw new Error("unexpected trailing token");
  }
  return root;
}

function collectIdentifiers(node, identifiers = []) {
  if (node.type === "identifier") {
    identifiers.push(node.value);
    return identifiers;
  }
  if (node.type === "with") {
    collectIdentifiers(node.license, identifiers);
    collectIdentifiers(node.exception, identifiers);
    return identifiers;
  }
  collectIdentifiers(node.left, identifiers);
  collectIdentifiers(node.right, identifiers);
  return identifiers;
}

function classifyIdentifier(identifier) {
  const normalized = identifier.toUpperCase();
  if (ALLOWED_LICENSES.has(normalized)) {
    return "allowed";
  }
  if (
    FAIL_CLOSED_IDENTIFIERS.has(normalized) ||
    normalized.startsWith("LICENSEREF-") ||
    normalized.startsWith("DOCUMENTREF-")
  ) {
    return "unknown";
  }
  if (KNOWN_REJECTED_LICENSES.has(normalized) || KNOWN_REJECTED_PATTERN.test(normalized)) {
    return "rejected";
  }
  return "unknown";
}

function evaluateNode(node) {
  if (node.type === "identifier") {
    return classifyIdentifier(node.value) === "allowed";
  }
  if (node.type === "with") {
    return false;
  }
  if (node.type === "and") {
    return evaluateNode(node.left) && evaluateNode(node.right);
  }
  return evaluateNode(node.left) || evaluateNode(node.right);
}

export function evaluateLicenseExpression(expression) {
  if (typeof expression !== "string" || expression.trim() === "") {
    return { allowed: false, reason: "license metadata is missing" };
  }

  let tree;
  try {
    tree = parseExpression(expression.trim());
  } catch {
    return { allowed: false, reason: "license expression is malformed or unsupported" };
  }

  const classifications = collectIdentifiers(tree).map(classifyIdentifier);
  if (classifications.includes("unknown")) {
    return { allowed: false, reason: "license expression contains an unknown identifier" };
  }
  if (!evaluateNode(tree)) {
    return { allowed: false, reason: "license expression is outside the allow policy" };
  }
  return { allowed: true, reason: "allowed" };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  return JSON.stringify(actualKeys) === JSON.stringify([...expectedKeys].sort());
}

function reviewKey(name, version) {
  return `${name}@${version}`;
}

function loadReviews(path) {
  const config = loadJson(path, "license review configuration");
  if (!hasExactKeys(config, ["reviews", "schemaVersion"]) || config.schemaVersion !== 1) {
    throw new Error("license review configuration has an unsupported schema");
  }
  if (!Array.isArray(config.reviews)) {
    throw new Error("license review configuration must contain a reviews array");
  }

  const reviews = new Map();
  for (const review of config.reviews) {
    if (!hasExactKeys(review, REVIEW_FIELDS)) {
      throw new Error("license review contains missing or unsupported fields");
    }
    if (
      typeof review.name !== "string" ||
      typeof review.version !== "string" ||
      typeof review.expectedLicense !== "string" ||
      typeof review.licenseFile !== "string" ||
      typeof review.licenseSha256 !== "string" ||
      typeof review.pnpmLockIntegrity !== "string"
    ) {
      throw new Error("license review contains invalid field types");
    }

    const key = reviewKey(review.name, review.version);
    if (key !== SUPPORTED_REVIEW_KEY) {
      throw new Error("license review targets an unsupported package");
    }
    if (review.expectedLicense !== "Apache-2.0" || review.licenseFile !== "LICENSE.md") {
      throw new Error("license review has an unsupported reviewed license or license path");
    }
    if (!/^[a-f0-9]{64}$/u.test(review.licenseSha256)) {
      throw new Error("license review has an invalid LICENSE.md SHA-256");
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(review.pnpmLockIntegrity)) {
      throw new Error("license review has an invalid pnpm lockfile integrity");
    }
    if (
      !hasExactKeys(review.repository, ["directory", "type", "url"]) ||
      Object.values(review.repository).some((value) => typeof value !== "string" || value === "")
    ) {
      throw new Error("license review has an invalid repository binding");
    }
    if (reviews.has(key)) {
      throw new Error("license review configuration contains a duplicate package review");
    }
    reviews.set(key, review);
  }
  return reviews;
}

function findLockfileIntegrity(lockfile, review) {
  const target = `  '${reviewKey(review.name, review.version)}':`;
  const lines = lockfile.split(/\r?\n/u);
  const matches = lines.flatMap((line, index) => (line === target ? [index] : []));
  if (matches.length !== 1) {
    return { allowed: false, reason: "reviewed package lockfile entry is missing or ambiguous" };
  }

  const start = matches[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  \S/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const integrityMatches = lines.slice(start + 1, end).flatMap((line) => {
    const match = /^    resolution:\s*\{[^}]*\bintegrity:\s*([^,}\s]+)[^}]*\}\s*$/u.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  if (integrityMatches.length !== 1) {
    return { allowed: false, reason: "reviewed package lockfile integrity is missing or ambiguous" };
  }
  if (integrityMatches[0] !== review.pnpmLockIntegrity) {
    return { allowed: false, reason: "reviewed package lockfile integrity mismatch" };
  }
  return { allowed: true, reason: "lockfile integrity matches" };
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isPlainObject(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertRegularDirectory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a regular directory`);
  }
}

function resolveReviewedPackagePath(inventoryPath, review) {
  const absoluteInventoryPath = resolve(inventoryPath);
  const pathSegments = absoluteInventoryPath.split(sep);
  const pnpmIndex = pathSegments.lastIndexOf(".pnpm");
  const packageSegments = review.name.split("/");
  const expectedTail = ["node_modules", ...packageSegments];
  if (
    pnpmIndex < 1 ||
    pathSegments.length !== pnpmIndex + 2 + expectedTail.length ||
    pathSegments.slice(pnpmIndex + 2).some((segment, index) => segment !== expectedTail[index])
  ) {
    throw new Error("reviewed package inventory path is not a pnpm virtual-store path");
  }

  const encodedPackage = review.name.replace("/", "+");
  const virtualEntry = pathSegments[pnpmIndex + 1] ?? "";
  if (virtualEntry !== `${encodedPackage}@${review.version}` &&
      !virtualEntry.startsWith(`${encodedPackage}@${review.version}_`)) {
    throw new Error("reviewed package inventory path does not match its name and version");
  }

  const virtualStorePath = pathSegments.slice(0, pnpmIndex + 1).join(sep) || sep;
  assertRegularDirectory(virtualStorePath, "pnpm virtual store");
  const realVirtualStorePath = realpathSync(virtualStorePath);
  const candidates = [];
  for (const entry of readdirSync(virtualStorePath, { withFileTypes: true })) {
    if (
      entry.name !== `${encodedPackage}@${review.version}` &&
      !entry.name.startsWith(`${encodedPackage}@${review.version}_`)
    ) {
      continue;
    }

    const entryPath = join(virtualStorePath, entry.name);
    assertRegularDirectory(entryPath, "reviewed package virtual-store entry");
    let parentPath = join(entryPath, "node_modules");
    const parentStat = lstatIfPresent(parentPath);
    if (!parentStat) {
      continue;
    }
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error("reviewed package virtual-store node_modules is not a regular directory");
    }
    for (const segment of packageSegments.slice(0, -1)) {
      parentPath = join(parentPath, segment);
      assertRegularDirectory(parentPath, "reviewed package scope directory");
    }
    const candidatePath = join(parentPath, packageSegments.at(-1));
    const candidateStat = lstatIfPresent(candidatePath);
    if (!candidateStat) {
      continue;
    }
    if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
      throw new Error("reviewed package virtual-store candidate is not a regular directory");
    }

    const realCandidatePath = realpathSync(candidatePath);
    const relativeCandidatePath = relative(realVirtualStorePath, realCandidatePath);
    if (
      relativeCandidatePath === "" ||
      relativeCandidatePath === ".." ||
      relativeCandidatePath.startsWith(`..${sep}`) ||
      isAbsolute(relativeCandidatePath)
    ) {
      throw new Error("reviewed package virtual-store candidate escapes its store boundary");
    }
    candidates.push(realCandidatePath);
  }

  if (candidates.length !== 1) {
    throw new Error("reviewed package must resolve to exactly one pnpm virtual-store installation");
  }
  return candidates[0];
}

function inspectArtifactTree(packagePath, licenseFile) {
  const licenseMatches = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === "ee") {
        throw new Error("reviewed package contains a forbidden ee path segment");
      }
      const entryPath = join(directory, entry.name);
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error("reviewed package contains a symbolic link");
      }
      if (stat.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("reviewed package contains a special filesystem entry");
      }
      if (entry.name.toLowerCase() === "license.md") {
        licenseMatches.push(relative(packagePath, entryPath));
      }
    }
  }

  const rootStat = lstatSync(packagePath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("reviewed package installation root is not a regular directory");
  }
  visit(packagePath);
  if (licenseMatches.length !== 1 || licenseMatches[0] !== licenseFile) {
    throw new Error("reviewed package LICENSE.md is missing or ambiguous");
  }
}

function repositoriesMatch(actual, expected) {
  return hasExactKeys(actual, ["directory", "type", "url"]) &&
    actual.directory === expected.directory &&
    actual.type === expected.type &&
    actual.url === expected.url;
}

function verifyReviewedPackage(entry, review, lockfile) {
  if (
    !Array.isArray(entry?.versions) ||
    entry.versions.length !== 1 ||
    entry.versions[0] !== review.version
  ) {
    return { allowed: false, reason: "reviewed package inventory version mismatch" };
  }
  if (!Array.isArray(entry.paths) || entry.paths.length !== 1 || !isAbsolute(entry.paths[0])) {
    return { allowed: false, reason: "reviewed package must have exactly one absolute install path" };
  }

  const lockResult = findLockfileIntegrity(lockfile, review);
  if (!lockResult.allowed) {
    return lockResult;
  }

  try {
    const packagePath = resolveReviewedPackagePath(entry.paths[0], review);
    inspectArtifactTree(packagePath, review.licenseFile);
    const manifestPath = join(packagePath, "package.json");
    const manifestStat = lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      return { allowed: false, reason: "reviewed package manifest is not a regular file" };
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== review.name || manifest.version !== review.version) {
      return { allowed: false, reason: "reviewed package manifest name or version mismatch" };
    }
    if (!repositoriesMatch(manifest.repository, review.repository)) {
      return { allowed: false, reason: "reviewed package repository mismatch" };
    }
    if (Object.hasOwn(manifest, "license")) {
      if (
        typeof manifest.license !== "string" ||
        manifest.license.trim().toUpperCase() !== "UNKNOWN"
      ) {
        return {
          allowed: false,
          reason: "reviewed override applies only to missing license metadata",
        };
      }
    }

    const licenseBytes = readFileSync(join(packagePath, review.licenseFile));
    const licenseSha256 = createHash("sha256").update(licenseBytes).digest("hex");
    if (licenseSha256 !== review.licenseSha256) {
      return { allowed: false, reason: "reviewed package LICENSE.md SHA-256 mismatch" };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "reviewed package artifact verification failed";
    return { allowed: false, reason };
  }

  const expectedLicense = evaluateLicenseExpression(review.expectedLicense);
  if (!expectedLicense.allowed) {
    return { allowed: false, reason: "reviewed expected license is outside policy" };
  }
  return { allowed: true, reason: "exact reviewed package evidence matched" };
}

function safeLabel(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  return value.replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, 160);
}

function dependencyLabel(entry) {
  const name = safeLabel(entry?.name, "<unnamed-package>");
  const versions = Array.isArray(entry?.versions)
    ? entry.versions.map((version) => safeLabel(version, "?")).join(",")
    : "?";
  return `${name}@${versions || "?"}`;
}

export function checkLicenseInventory(inventory, { reviews = new Map(), lockfile = "" } = {}) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("license inventory must be a JSON object");
  }

  const failures = [];
  const reviewAttempts = new Map([...reviews.keys()].map((key) => [key, 0]));
  let appliedReviews = 0;
  let checked = 0;
  for (const entries of Object.values(inventory)) {
    if (!Array.isArray(entries)) {
      failures.push({ dependency: "<invalid-inventory>", reason: "inventory group is not an array" });
      continue;
    }
    for (const entry of entries) {
      checked += 1;
      let result = evaluateLicenseExpression(entry?.license);
      const matchingReview = [...reviews.values()].find((review) => review.name === entry?.name);
      const eligibleForReview =
        typeof entry?.license !== "string" ||
        entry.license.trim() === "" ||
        entry.license.trim().toUpperCase() === "UNKNOWN";
      if (!result.allowed && matchingReview && eligibleForReview) {
        const key = reviewKey(matchingReview.name, matchingReview.version);
        reviewAttempts.set(key, (reviewAttempts.get(key) ?? 0) + 1);
        result = verifyReviewedPackage(entry, matchingReview, lockfile);
        if (result.allowed) {
          appliedReviews += 1;
        }
      }
      if (!result.allowed) {
        failures.push({ dependency: dependencyLabel(entry), reason: result.reason });
      }
    }
  }

  if (checked === 0) {
    failures.push({
      dependency: "<empty-inventory>",
      reason: "production license inventory contains no packages",
    });
  }

  for (const [key, attempts] of reviewAttempts) {
    if (attempts !== 1) {
      failures.push({
        dependency: key,
        reason: "reviewed package must appear exactly once in the production inventory",
      });
    }
  }

  return { checked, failures, appliedReviews };
}

function loadJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} could not be read as JSON`);
  }
  return parsed;
}

function resolvePinnedPnpmInvocation() {
  const manifest = loadJson(resolve("package.json"), "root package manifest");
  const match = typeof manifest.packageManager === "string"
    ? /^pnpm@(?<version>[0-9]+\.[0-9]+\.[0-9]+)$/u.exec(manifest.packageManager)
    : null;
  const expectedVersion = match?.groups?.version;
  if (!expectedVersion) {
    throw new Error("root package manifest must pin an exact pnpm packageManager version");
  }

  const candidates = [
    { command: "pnpm", prefix: [] },
    { command: "corepack", prefix: ["pnpm"] },
  ];
  for (const candidate of candidates) {
    const version = spawnSync(candidate.command, [...candidate.prefix, "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
    });
    if (!version.error && version.status === 0 && version.stdout.trim() === expectedVersion) {
      return candidate;
    }
  }
  throw new Error(`the pinned pnpm ${expectedVersion} executable is unavailable`);
}

function loadProductionInventory() {
  const pnpm = resolvePinnedPnpmInvocation();
  const result = spawnSync(pnpm.command, [...pnpm.prefix, "licenses", "list", "--prod", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error("pnpm could not produce the production license inventory");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("pnpm produced an invalid production license inventory");
  }
}

function parseArguments(arguments_) {
  if (arguments_.length % 2 !== 0) {
    throw new Error(
      "usage: node scripts/check-license-policy.mjs [--inventory path] [--reviews path] [--lockfile path]",
    );
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !option ||
      !value ||
      !["--inventory", "--lockfile", "--reviews"].includes(option) ||
      values.has(option)
    ) {
      throw new Error(
        "usage: node scripts/check-license-policy.mjs [--inventory path] [--reviews path] [--lockfile path]",
      );
    }
    values.set(option, resolve(value));
  }
  return values;
}

function main() {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    const inventoryPath = arguments_.get("--inventory");
    const reviewsPath = arguments_.get("--reviews") ?? resolve("config/license-reviews.json");
    const lockfilePath = arguments_.get("--lockfile") ?? resolve("pnpm-lock.yaml");
    const inventory = inventoryPath
      ? loadJson(inventoryPath, "license inventory")
      : loadProductionInventory();
    const reviews = loadReviews(reviewsPath);
    const lockfile = readFileSync(lockfilePath, "utf8");
    const { checked, failures, appliedReviews } = checkLicenseInventory(inventory, {
      reviews,
      lockfile,
    });
    if (failures.length > 0) {
      console.error(`License policy rejected ${failures.length} of ${checked} production packages:`);
      for (const failure of failures) {
        console.error(`- ${failure.dependency}: ${failure.reason}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `License policy accepted ${checked} production packages with ${appliedReviews} exact reviewed override(s).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "license policy check failed";
    console.error(`License policy check failed: ${message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main();
}
