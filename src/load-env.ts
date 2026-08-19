import { dot, envFileNames } from "@moego/aws-secret-env";

export function runtimeEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const namespace = env.NAMESPACE?.trim();
  if (!namespace) return undefined;
  return namespace.startsWith("ns-") ? namespace.slice(3) : namespace;
}

export function runtimeEnvFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return envFileNames(runtimeEnvironment(env) ?? "testing");
}

const envResult = dot.config({ defaultEnvironment: "testing", quiet: true });
if (envResult.error) throw envResult.error;
