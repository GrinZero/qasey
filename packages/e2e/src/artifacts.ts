import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArtifactRef } from "../../contracts/src/index.ts";

export interface ArtifactStore {
  savePatch(runId: string, patch: string): Promise<ArtifactRef>;
  loadPatch(runId: string): Promise<string>;
  persist(runId: string, phase: "author" | "verifier", artifacts: ArtifactRef[]): Promise<ArtifactRef[]>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async savePatch(runId: string, patch: string): Promise<ArtifactRef> {
    const directory = await this.directory(runId);
    const target = join(directory, "changes.patch");
    await writeFile(target, patch, { mode: 0o600 });
    return { id: `${runId}:patch`, kind: "patch", name: "changes.patch", uri: pathToFileURL(target).href };
  }

  async loadPatch(runId: string): Promise<string> {
    return readFile(join(await this.directory(runId), "changes.patch"), "utf8");
  }

  async persist(runId: string, phase: "author" | "verifier", artifacts: ArtifactRef[]): Promise<ArtifactRef[]> {
    const directory = join(await this.directory(runId), phase);
    await mkdir(directory, { recursive: true });
    const persisted: ArtifactRef[] = [];
    for (const [index, artifact] of artifacts.entries()) {
      if (!artifact.uri.startsWith("file://")) { persisted.push(artifact); continue; }
      const source = fileURLToPath(artifact.uri);
      const target = join(directory, `${String(index).padStart(3, "0")}-${basename(source)}`);
      await copyFile(source, target);
      const checksum = createHash("sha256").update(await readFile(target)).digest("hex");
      persisted.push({ ...artifact, id: `${runId}:${phase}:${index}`, name: `${phase}/${artifact.name}`, uri: pathToFileURL(target).href, sha256: checksum });
    }
    return persisted;
  }

  private async directory(runId: string): Promise<string> {
    const safeRunId = runId.replace(/[^a-zA-Z0-9-]/g, "-");
    const directory = resolve(this.root, safeRunId);
    await mkdir(directory, { recursive: true });
    return directory;
  }
}
