#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename } from "node:path";

const args = process.argv.slice(2);

if (args[0] === "repo" && args[1] === "clone" && process.env.QASEY_GH_BROKER_URL && process.env.QASEY_GH_BROKER_TOKEN) {
  await brokeredClone(args.slice(2));
} else {
  process.exitCode = await runRealGh(args);
}

async function brokeredClone(input: string[]): Promise<void> {
  const separator = input.indexOf("--");
  const ghArgs = separator >= 0 ? input.slice(0, separator) : input;
  const gitArgs = separator >= 0 ? input.slice(separator + 1) : [];
  const positional = ghArgs.filter(value => !value.startsWith("-"));
  const repository = positional[0];
  if (!repository) return exitWith("gh repo clone requires OWNER/REPO");
  const normalized = normalizeRepository(repository);
  if (!normalized) return exitWith("Qasey cached clone requires an OWNER/REPO or GitHub repository URL");
  const destination = positional[1] ?? basename(normalized);
  const unsupportedGhOption = ghArgs.find(value => value.startsWith("-") && value !== "--no-upstream");
  if (unsupportedGhOption) return exitWith(`Qasey cached clone does not support gh option ${unsupportedGhOption}`);
  const unsupportedGitOption = unsupportedGitArgument(gitArgs);
  if (unsupportedGitOption) return exitWith(`Qasey cached clone does not support git option ${unsupportedGitOption}`);
  const bare = gitArgs.includes("--bare") || gitArgs.includes("--mirror");
  const ref = optionValue(gitArgs, "--branch") ?? optionValue(gitArgs, "-b");
  const response = await fetch(process.env.QASEY_GH_BROKER_URL!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-qasey-repository-token": process.env.QASEY_GH_BROKER_TOKEN!,
    },
    body: JSON.stringify({ repository: normalized, destination, bare, ...(ref ? { ref } : {}) }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const body = await response.json().catch(() => undefined) as { destination?: string; cacheHit?: boolean; resolvedSha?: string; message?: string } | undefined;
  if (!response.ok) return exitWith(body?.message ?? `Qasey repository broker failed with ${response.status}`);
  process.stdout.write(`Cloned ${normalized} into ${body?.destination ?? destination} (${body?.cacheHit ? "shared cache hit" : "shared cache populated"})${body?.resolvedSha ? ` at ${body.resolvedSha}` : ""}\n`);
}

function normalizeRepository(value: string): string | undefined {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    const normalized = value.replace(/\.git$/u, "");
    return validRepositoryParts(normalized.split("/")) ? normalized : undefined;
  }
  try {
    const url = new URL(value);
    if (!/(?:^|\.)github\.com$/iu.test(url.hostname) && url.hostname !== process.env.GH_HOST) return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "").split("/");
    return validRepositoryParts(parts) ? `${parts[0]}/${parts[1]}` : undefined;
  } catch {
    return undefined;
  }
}

function validRepositoryParts(parts: string[]): parts is [string, string] {
  return parts.length === 2 && parts.every(part => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== "..");
}

function unsupportedGitArgument(values: string[]): string | undefined {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--bare" || value === "--mirror") continue;
    if (value.startsWith("--branch=")) continue;
    if (value === "-b" || value === "--branch") {
      if (!values[index + 1]) return value;
      index += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

function optionValue(values: string[], option: string): string | undefined {
  const direct = values.find(value => value.startsWith(`${option}=`));
  if (direct) return direct.slice(option.length + 1);
  const index = values.indexOf(option);
  return index >= 0 ? values[index + 1] : undefined;
}

function runRealGh(arguments_: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.QASEY_REAL_GH_PATH ?? "/usr/bin/gh", arguments_, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
}

function exitWith(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}
