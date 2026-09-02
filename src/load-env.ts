import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseEnv } from "node:util";

export interface RuntimeEnvConfigResult {
  environment: string;
  loadedFiles: string[];
  parsed: Record<string, string>;
}

export function runtimeEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return parseRuntimeEnvironment(env.NODE_ENV);
}

export function runtimeEnvFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return envFileNames(runtimeEnvironment(env) ?? "development");
}

export function envFileNames(environment: string): string[] {
  const safeEnvironment = parseRuntimeEnvironment(environment);
  if (!safeEnvironment) throw new Error("NODE_ENV is required to select environment files");
  return [
    ".env",
    `.env.${safeEnvironment}`,
    ".env.local",
    `.env.${safeEnvironment}.local`,
  ];
}

function environmentFromFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return parseRuntimeEnvironment(parseEnv(readFileSync(file, "utf8")).NODE_ENV);
}

function parseRuntimeEnvironment(value: string | undefined): string | undefined {
  const environment = value?.trim();
  if (!environment) return undefined;
  if (!/^(?:development|test|production)$/u.test(environment)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  return environment;
}

export function resolveRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  defaultEnvironment = "development",
): string {
  // Validate caller-controlled defaults before consulting filesystem paths so
  // a local env file cannot mask an unsafe environment selector.
  const parsedDefaultEnvironment = parseRuntimeEnvironment(defaultEnvironment);
  return runtimeEnvironment(env)
    ?? environmentFromFile(resolve(cwd, ".env.local"))
    ?? environmentFromFile(resolve(cwd, ".env"))
    ?? parsedDefaultEnvironment
    ?? "development";
}

export function loadRuntimeEnv(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  defaultEnvironment?: string;
} = {}): RuntimeEnvConfigResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const environment = resolveRuntimeEnvironment(env, cwd, options.defaultEnvironment);
  const parsed: Record<string, string> = {};
  const loadedFiles: string[] = [];

  for (const candidate of envFileNames(environment)) {
    const file = resolve(cwd, candidate);
    if (!existsSync(file)) continue;
    Object.assign(parsed, parseEnv(readFileSync(file, "utf8")));
    loadedFiles.push(file);
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(env, key)) env[key] = value;
  }
  return { environment, loadedFiles, parsed };
}

export interface RuntimeEnvLoadReport {
  event: "runtime.env.loaded";
  environment: string | null;
  environmentResolutionOrder: string[];
  candidateFiles: string[];
  loadedFiles: string[];
  skippedFiles: string[];
  existingProcessEnvPrecedence: "highest";
  filePrecedence: "later-file-wins";
  parsedKeyCount: number;
  appliedKeyCount: number;
  preservedProcessKeyCount: number;
  valuesLogged: false;
}

export function createRuntimeEnvLoadReport(
  result: RuntimeEnvConfigResult,
  preexistingKeys: ReadonlySet<string>,
  cwd = process.cwd(),
): RuntimeEnvLoadReport {
  const candidateFiles = envFileNames(result.environment);
  const loadedFiles = result.loadedFiles.map(file => relative(cwd, file) || file);
  const loadedNames = new Set(loadedFiles);
  const parsedKeys = Object.keys(result.parsed ?? {});
  return {
    event: "runtime.env.loaded",
    environment: result.environment ?? null,
    environmentResolutionOrder: [
      "process.env.NODE_ENV",
      ".env.local NODE_ENV",
      ".env NODE_ENV",
      "options.defaultEnvironment (development fallback)",
    ],
    candidateFiles,
    loadedFiles,
    skippedFiles: candidateFiles.filter(file => !loadedNames.has(file)),
    existingProcessEnvPrecedence: "highest",
    filePrecedence: "later-file-wins",
    parsedKeyCount: parsedKeys.length,
    appliedKeyCount: parsedKeys.filter(key => !preexistingKeys.has(key)).length,
    preservedProcessKeyCount: parsedKeys.filter(key => preexistingKeys.has(key)).length,
    valuesLogged: false,
  };
}

const preexistingEnvKeys = new Set(Object.keys(process.env));
const envResult = loadRuntimeEnv();
if (process.env.NODE_ENV !== "test") {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    service: "qasey",
    ...createRuntimeEnvLoadReport(envResult, preexistingEnvKeys),
  }));
}
