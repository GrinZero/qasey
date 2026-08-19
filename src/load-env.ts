import { dot, envFileNames, type DotConfigResult } from "@moego/aws-secret-env";
import { relative } from "node:path";

export function runtimeEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const namespace = env.NAMESPACE?.trim();
  if (!namespace) return undefined;
  return namespace.startsWith("ns-") ? namespace.slice(3) : namespace;
}

export function runtimeEnvFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return envFileNames(runtimeEnvironment(env) ?? "testing");
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
  result: DotConfigResult,
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
      "explicit environment option",
      "process.env.NAMESPACE",
      ".env.local NAMESPACE",
      ".env NAMESPACE",
      "default environment (testing)",
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
const envResult = dot.config({ defaultEnvironment: "testing", quiet: true });
if (envResult.error) throw envResult.error;
if (process.env.NODE_ENV !== "test") {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    service: "qasey",
    ...createRuntimeEnvLoadReport(envResult, preexistingEnvKeys),
  }));
}
