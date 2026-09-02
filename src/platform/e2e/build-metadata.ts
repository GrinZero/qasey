import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const SourceShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const BuildMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  sourceSha: SourceShaSchema,
}).strict();

export type BuildMetadata = z.infer<typeof BuildMetadataSchema>;

function readTrimmed(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value || undefined;
}

function resolveGitDirectory(projectRoot: string): string | undefined {
  const marker = resolve(projectRoot, ".git");
  if (!existsSync(marker)) return undefined;
  try {
    const pointer = readFileSync(marker, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return marker;
    const path = pointer.slice("gitdir: ".length);
    return isAbsolute(path) ? path : resolve(projectRoot, path);
  } catch {
    return marker;
  }
}

function shaFromPackedRefs(gitDirectory: string, reference: string): string | undefined {
  const packed = readTrimmed(resolve(gitDirectory, "packed-refs"));
  if (!packed) return undefined;
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.trim().split(/\s+/u);
    if (name === reference && sha && SourceShaSchema.safeParse(sha).success) return sha;
  }
  return undefined;
}

export function resolveGitSourceSha(projectRoot: string): string | undefined {
  const gitDirectory = resolveGitDirectory(projectRoot);
  if (!gitDirectory) return undefined;
  const head = readTrimmed(resolve(gitDirectory, "HEAD"));
  if (!head) return undefined;
  if (SourceShaSchema.safeParse(head).success) return head;
  if (!head.startsWith("ref: ")) return undefined;
  const reference = head.slice("ref: ".length);
  const loose = readTrimmed(resolve(gitDirectory, reference));
  if (loose && SourceShaSchema.safeParse(loose).success) return loose;
  return shaFromPackedRefs(gitDirectory, reference);
}

export function buildMetadataPath(projectRoot: string): string {
  return resolve(projectRoot, ".qasey", "build-metadata.json");
}

export function resolveBuildMetadata(projectRoot: string): BuildMetadata {
  const gitSha = resolveGitSourceSha(projectRoot);
  if (gitSha) return { schemaVersion: 1, sourceSha: gitSha };

  const path = buildMetadataPath(projectRoot);
  if (existsSync(path)) return BuildMetadataSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  throw new Error(
    `Qasey build source metadata is unavailable at ${path}. Build the application from a Git checkout so the artifact is generated automatically.`,
  );
}

export function resolveBuildMetadataDirectory(projectRoot: string): string {
  return dirname(buildMetadataPath(projectRoot));
}
