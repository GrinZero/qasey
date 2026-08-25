import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArtifactRef, E2EExecutionBrief, OwnerScope } from "../../contracts/src/index.ts";

export interface ArtifactStore {
  savePatch(owner: OwnerScope, runId: string, patch: string): Promise<ArtifactRef>;
  loadPatch(owner: OwnerScope, runId: string): Promise<string>;
  saveContext(owner: OwnerScope, runId: string, brief: E2EExecutionBrief): Promise<ArtifactRef>;
  saveTaskContext(owner: OwnerScope, runId: string, taskId: string, content: string): Promise<ArtifactRef>;
  persistContent(owner: OwnerScope, runId: string, phase: "author" | "verifier", artifact: ArtifactRef, content: Buffer): Promise<ArtifactRef>;
  persist(owner: OwnerScope, runId: string, phase: "author" | "verifier", artifacts: ArtifactRef[]): Promise<ArtifactRef[]>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async savePatch(owner: OwnerScope, runId: string, patch: string): Promise<ArtifactRef> {
    const directory = await this.directory(owner, runId);
    const target = join(directory, "changes.patch");
    await writeFile(target, patch, { mode: 0o600 });
    return {
      id: `${runId}:patch`, kind: "patch", name: "changes.patch", uri: pathToFileURL(target).href,
      contentType: "text/x-diff", sha256: createHash("sha256").update(patch).digest("hex"),
    };
  }

  async loadPatch(owner: OwnerScope, runId: string): Promise<string> {
    return readFile(join(await this.directory(owner, runId), "changes.patch"), "utf8");
  }

  async saveContext(owner: OwnerScope, runId: string, brief: E2EExecutionBrief): Promise<ArtifactRef> {
    const directory = await this.directory(owner, runId);
    const target = join(directory, "execution-brief.json");
    const content = JSON.stringify(brief);
    await writeFile(target, content, { mode: 0o600 });
    return {
      id: `${runId}:execution-brief`,
      kind: "report",
      name: "execution-brief.json",
      uri: pathToFileURL(target).href,
      contentType: "application/json",
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  async saveTaskContext(owner: OwnerScope, runId: string, taskId: string, content: string): Promise<ArtifactRef> {
    const directory = join(await this.directory(owner, runId), "contexts");
    await mkdir(directory, { recursive: true });
    const name = `${safeSegment(taskId)}.json`;
    const target = join(directory, name);
    await writeFile(target, content, { mode: 0o600 });
    return {
      id: `${runId}:context:${safeSegment(taskId)}`,
      kind: "report",
      name: `contexts/${name}`,
      uri: pathToFileURL(target).href,
      contentType: "application/json",
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  async persistContent(owner: OwnerScope, runId: string, phase: "author" | "verifier", artifact: ArtifactRef, content: Buffer): Promise<ArtifactRef> {
    const directory = join(await this.directory(owner, runId), phase);
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${safeSegment(artifact.id)}-${basename(artifact.name)}`);
    await writeFile(target, content, { mode: 0o600 });
    return {
      ...artifact,
      id: `${runId}:${phase}:${safeSegment(artifact.id)}`,
      name: `${phase}/${artifact.name}`,
      uri: pathToFileURL(target).href,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  async persist(owner: OwnerScope, runId: string, phase: "author" | "verifier", artifacts: ArtifactRef[]): Promise<ArtifactRef[]> {
    const directory = join(await this.directory(owner, runId), phase);
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

  private async directory(owner: OwnerScope, runId: string): Promise<string> {
    const root = resolve(this.root);
    const directory = resolve(root, safeSegment(owner.applicationId), safeSegment(owner.tenantId), safeSegment(runId));
    if (directory !== root && !directory.startsWith(`${root}${sep}`)) throw new Error("Artifact path escaped configured root");
    await mkdir(directory, { recursive: true });
    return directory;
  }
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+$/u, "-").slice(0, 160);
  if (!segment) throw new Error("Artifact owner scope contains an empty path segment");
  return segment;
}
