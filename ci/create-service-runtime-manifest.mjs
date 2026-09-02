#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const [sourcePath, sourceLockPath, destinationPath, destinationLockPath, ...optionArgs] = process.argv.slice(2);
if (!sourcePath || !sourceLockPath || !destinationPath || !destinationLockPath) {
  throw new Error(
    "Usage: create-service-runtime-manifest.mjs <source-package.json> <source-lock.yaml> <destination-package.json> <destination-lock.yaml> [--profile service|sandbox] [--source-workspace <path> --destination-workspace <path>]",
  );
}

const options = parseOptions(optionArgs);
if (!new Set(["service", "sandbox"]).has(options.profile)) {
  throw new Error(`Unsupported runtime dependency profile: ${options.profile}`);
}
if (Boolean(options.sourceWorkspacePath) !== Boolean(options.destinationWorkspacePath)) {
  throw new Error("--source-workspace and --destination-workspace must be provided together");
}

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const sourceLock = await readFile(sourceLockPath, "utf8");
const importer = parseRootImporter(sourceLock);
const dependencyNames = options.profile === "sandbox"
  ? ["@ai-sdk/openai", "@mastra/core", "@playwright/test", "@trycua/cua-driver", "jose", "zod"]
  : [
      ...Object.keys(source.dependencies ?? {})
        .filter(name => name !== "@playwright/test" && name !== "@trycua/cua-driver"),
      "prisma",
    ];

const dependencies = {};
const lockDependencies = new Map();
for (const name of dependencyNames) {
  const record = importer.get(name);
  if (!record?.version) throw new Error(`pnpm-lock.yaml has no resolved root dependency for ${name}`);
  const exactVersion = exactResolvedVersion(record.version, name);
  dependencies[name] = exactVersion;
  lockDependencies.set(name, { specifier: exactVersion, version: record.version });
}

const manifest = {
  name: `qasey-${options.profile}-runtime`,
  private: true,
  type: "module",
  packageManager: source.packageManager,
  engines: source.engines,
  dependencies,
};
await writeFile(destinationPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
await writeFile(destinationLockPath, serviceLockfile(sourceLock, lockDependencies), { mode: 0o644 });
if (options.sourceWorkspacePath && options.destinationWorkspacePath) {
  const sourceWorkspace = await readFile(options.sourceWorkspacePath, "utf8");
  const lockOverrides = topLevelSection(sourceLock, "overrides");
  const workspaceOverrides = topLevelSection(sourceWorkspace, "overrides");
  if (!lockOverrides || !workspaceOverrides ||
      JSON.stringify(simpleMapping(lockOverrides)) !== JSON.stringify(simpleMapping(workspaceOverrides))) {
    throw new Error("pnpm lockfile and workspace overrides must exist and match exactly");
  }
  await writeFile(
    options.destinationWorkspacePath,
    runtimeWorkspace(sourceWorkspace, workspaceOverrides, lockDependencies),
    { mode: 0o644 },
  );
}

function parseRootImporter(lockfile) {
  const records = new Map();
  let inRoot = false;
  let section;
  let current;
  for (const line of lockfile.split("\n")) {
    if (line === "  .:") {
      inRoot = true;
      continue;
    }
    if (!inRoot) continue;
    if (/^  \S/u.test(line)) break;
    const sectionMatch = /^    (dependencies|devDependencies):$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      current = undefined;
      continue;
    }
    const dependencyMatch = /^      (.+):$/u.exec(line);
    if (dependencyMatch && section) {
      current = decodeYamlScalar(dependencyMatch[1]);
      records.set(current, { section });
      continue;
    }
    const fieldMatch = /^        (specifier|version): (.+)$/u.exec(line);
    if (fieldMatch && current) records.get(current)[fieldMatch[1]] = decodeYamlScalar(fieldMatch[2]);
  }
  return records;
}

function exactResolvedVersion(version, name) {
  const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/u.exec(version);
  if (!match) throw new Error(`${name} does not resolve to an exact public registry version`);
  return match[1];
}

function serviceLockfile(sourceLockfile, dependencies) {
  const version = /^lockfileVersion: .+$/mu.exec(sourceLockfile)?.[0];
  const settings = topLevelSection(sourceLockfile, "settings")?.trimEnd();
  const overrides = topLevelSection(sourceLockfile, "overrides")?.trimEnd();
  const packagesIndex = sourceLockfile.indexOf("\npackages:\n");
  const coreVersion = dependencies.get("@mastra/core")?.specifier;
  const escapedCoreVersion = coreVersion?.replaceAll(".", "\\.");
  const corePatch = escapedCoreVersion
    ? new RegExp(`^  ['\"]?@mastra/core@${escapedCoreVersion}['\"]?: (.+)$`, "mu").exec(sourceLockfile)?.[1]
    : undefined;
  if (!version || !settings || !overrides || packagesIndex < 0 || !coreVersion || !corePatch) {
    throw new Error("pnpm-lock.yaml is missing required lockfile, settings, overrides, package, or Mastra patch metadata");
  }

  const importerLines = [];
  for (const [name, record] of dependencies) {
    importerLines.push(
      `      ${yamlKey(name)}:`,
      `        specifier: ${record.specifier}`,
      `        version: ${record.version}`,
    );
  }
  return [
    version,
    "",
    settings,
    "",
    overrides,
    "",
    "patchedDependencies:",
    `  ${yamlKey(`@mastra/core@${coreVersion}`)}: ${corePatch}`,
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    ...importerLines,
    sourceLockfile.slice(packagesIndex + 1).trimEnd(),
    "",
  ].join("\n");
}

function runtimeWorkspace(sourceWorkspace, overrides, dependencies) {
  const allowBuilds = topLevelSection(sourceWorkspace, "allowBuilds")?.trimEnd();
  const coreVersion = dependencies.get("@mastra/core")?.specifier;
  const sourcePatches = topLevelSection(sourceWorkspace, "patchedDependencies");
  const patchPath = coreVersion && sourcePatches
    ? new RegExp(`^  ['\"]?@mastra/core@${coreVersion.replaceAll(".", "\\.")}['\"]?: (.+)$`, "mu")
      .exec(sourcePatches)?.[1]
    : undefined;
  if (!allowBuilds || !coreVersion || !patchPath) {
    throw new Error("pnpm-workspace.yaml is missing required allowBuilds or Mastra patch metadata");
  }
  return [
    "packages: []",
    allowBuilds,
    overrides.trimEnd(),
    "patchedDependencies:",
    `  ${yamlKey(`@mastra/core@${coreVersion}`)}: ${patchPath}`,
    "",
  ].join("\n");
}

function topLevelSection(yaml, name) {
  const lines = yaml.split("\n");
  const start = lines.findIndex(line => line === `${name}:`);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/u.test(lines[end]))) end += 1;
  return lines.slice(start, end).join("\n").trimEnd();
}

function simpleMapping(section) {
  return section.split("\n").slice(1)
    .filter(line => line.trim() && !line.trimStart().startsWith("#"))
    .map(line => {
    const separator = line.indexOf(": ");
    if (!line.startsWith("  ") || separator < 2) throw new Error(`Unsupported pnpm override syntax: ${line}`);
    return [decodeYamlScalar(line.slice(2, separator)), decodeYamlScalar(line.slice(separator + 2))];
    });
}

function parseOptions(args) {
  const options = { profile: "service", sourceWorkspacePath: undefined, destinationWorkspacePath: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${name}`);
    if (name === "--profile") options.profile = value;
    else if (name === "--source-workspace") options.sourceWorkspacePath = value;
    else if (name === "--destination-workspace") options.destinationWorkspacePath = value;
    else throw new Error(`Unknown option: ${name}`);
  }
  return options;
}

function decodeYamlScalar(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

function yamlKey(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
