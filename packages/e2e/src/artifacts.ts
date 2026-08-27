import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { ArtifactRef, E2EExecutionBrief, OwnerScope } from "../../contracts/src/index.ts";

export interface ArtifactStore {
  savePatch(owner: OwnerScope, runId: string, patch: string): Promise<ArtifactRef>;
  loadPatch(owner: OwnerScope, runId: string): Promise<string>;
  saveContext(owner: OwnerScope, runId: string, brief: E2EExecutionBrief): Promise<ArtifactRef>;
  saveTaskContext(owner: OwnerScope, runId: string, taskId: string, content: string): Promise<ArtifactRef>;
  persistContent(owner: OwnerScope, runId: string, phase: "author" | "verifier", artifact: ArtifactRef, content: Buffer): Promise<ArtifactRef>;
  persist(owner: OwnerScope, runId: string, phase: "author" | "verifier", artifacts: ArtifactRef[]): Promise<ArtifactRef[]>;
}

export interface OpenArtifact {
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
}

export interface DownloadableArtifactStore extends ArtifactStore {
  open(owner: OwnerScope, artifact: ArtifactRef): Promise<OpenArtifact>;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export class LocalArtifactStore implements DownloadableArtifactStore {
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

  async open(owner: OwnerScope, artifact: ArtifactRef): Promise<OpenArtifact> {
    if (!artifact.uri.startsWith("file://")) throw new ArtifactNotFoundError();
    const ownerRoot = await realpath(await this.ownerDirectory(owner));
    const target = await realpath(fileURLToPath(artifact.uri)).catch(() => { throw new ArtifactNotFoundError(); });
    if (target !== ownerRoot && !target.startsWith(`${ownerRoot}${sep}`)) throw new ArtifactOwnershipError();
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new ArtifactNotFoundError();
    return {
      body: Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>,
      contentLength: metadata.size,
    };
  }

  async healthCheck(): Promise<void> {
    await mkdir(resolve(this.root), { recursive: true });
  }

  async close(): Promise<void> {}

  private async directory(owner: OwnerScope, runId: string): Promise<string> {
    const root = resolve(this.root);
    const directory = resolve(await this.ownerDirectory(owner), safeSegment(runId));
    if (directory !== root && !directory.startsWith(`${root}${sep}`)) throw new Error("Artifact path escaped configured root");
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async ownerDirectory(owner: OwnerScope): Promise<string> {
    const directory = resolve(this.root, artifactOwnerSegment(owner.applicationId), artifactOwnerSegment(owner.tenantId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
}

interface S3Sender {
  send(command: object): Promise<unknown>;
  destroy?(): void;
}

export interface S3ArtifactStoreOptions {
  bucket: string;
  region: string;
  prefix?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  kmsKeyId?: string;
  retentionDays?: number;
  client?: S3Sender;
  now?: () => Date;
}

/**
 * Shared object storage for distributed deployments. Artifact references carry
 * an opaque object key, while bucket credentials and endpoints remain server
 * side. Every read revalidates owner metadata and the owner-scoped key prefix.
 */
export class S3ArtifactStore implements DownloadableArtifactStore {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly retentionDays: number;
  private readonly client: S3Sender;
  private readonly now: () => Date;
  private readonly kmsKeyId: string | undefined;

  constructor(options: S3ArtifactStoreOptions) {
    this.bucket = requiredSegment(options.bucket, "S3 artifact bucket");
    this.prefix = normalizePrefix(options.prefix ?? "qasey-artifacts");
    this.retentionDays = options.retentionDays ?? 30;
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1) {
      throw new Error("S3 artifact retentionDays must be a positive integer");
    }
    this.kmsKeyId = options.kmsKeyId;
    this.now = options.now ?? (() => new Date());
    if (options.client) {
      this.client = options.client;
    } else {
      const clientConfig: S3ClientConfig = {
        region: requiredSegment(options.region, "S3 artifact region"),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
      };
      this.client = new S3Client(clientConfig);
    }
  }

  async savePatch(owner: OwnerScope, runId: string, patch: string): Promise<ArtifactRef> {
    return this.put(owner, runId, "changes.patch", `${runId}:patch`, "patch", "text/x-diff", Buffer.from(patch));
  }

  async loadPatch(owner: OwnerScope, runId: string): Promise<string> {
    const object = await this.get(owner, this.key(owner, runId, "changes.patch"));
    return (await bodyToBuffer(object.Body)).toString("utf8");
  }

  async saveContext(owner: OwnerScope, runId: string, brief: E2EExecutionBrief): Promise<ArtifactRef> {
    return this.put(
      owner,
      runId,
      "execution-brief.json",
      `${runId}:execution-brief`,
      "report",
      "application/json",
      Buffer.from(JSON.stringify(brief)),
    );
  }

  async saveTaskContext(owner: OwnerScope, runId: string, taskId: string, content: string): Promise<ArtifactRef> {
    const task = safeSegment(taskId);
    return this.put(owner, runId, `contexts/${task}.json`, `${runId}:context:${task}`, "report", "application/json", Buffer.from(content));
  }

  async persistContent(
    owner: OwnerScope,
    runId: string,
    phase: "author" | "verifier",
    artifact: ArtifactRef,
    content: Buffer,
  ): Promise<ArtifactRef> {
    const name = `${phase}/${artifact.name}`;
    return this.put(
      owner,
      runId,
      `${phase}/${safeSegment(artifact.id)}-${basename(artifact.name)}`,
      `${runId}:${phase}:${safeSegment(artifact.id)}`,
      artifact.kind,
      artifact.contentType ?? "application/octet-stream",
      content,
      name,
    );
  }

  async persist(owner: OwnerScope, runId: string, phase: "author" | "verifier", artifacts: ArtifactRef[]): Promise<ArtifactRef[]> {
    const persisted: ArtifactRef[] = [];
    for (const [index, artifact] of artifacts.entries()) {
      if (!artifact.uri.startsWith("file://")) throw new Error(`Unsupported source artifact URI: ${artifact.uri}`);
      const content = await readFile(fileURLToPath(artifact.uri));
      persisted.push(await this.put(
        owner,
        runId,
        `${phase}/${String(index).padStart(3, "0")}-${basename(artifact.name)}`,
        `${runId}:${phase}:${index}`,
        artifact.kind,
        artifact.contentType ?? "application/octet-stream",
        content,
        `${phase}/${artifact.name}`,
      ));
    }
    return persisted;
  }

  async open(owner: OwnerScope, artifact: ArtifactRef): Promise<OpenArtifact> {
    const key = artifactKeyFromUri(artifact.uri);
    this.assertOwnedKey(owner, key);
    const object = await this.get(owner, key);
    if (artifact.sha256 && object.Metadata?.sha256 !== artifact.sha256) throw new ArtifactIntegrityError();
    if (!object.Body?.transformToWebStream) throw new ArtifactNotFoundError();
    return {
      body: object.Body.transformToWebStream(),
      ...(object.ContentLength !== undefined ? { contentLength: object.ContentLength } : {}),
    };
  }

  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async close(): Promise<void> {
    this.client.destroy?.();
  }

  private async put(
    owner: OwnerScope,
    runId: string,
    relativeName: string,
    id: string,
    kind: ArtifactRef["kind"],
    contentType: string,
    content: Buffer,
    displayName = relativeName,
  ): Promise<ArtifactRef> {
    const key = this.key(owner, runId, relativeName);
    const digest = createHash("sha256").update(content).digest();
    const expiresAt = new Date(this.now().getTime() + this.retentionDays * 24 * 60 * 60_000).toISOString();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      ChecksumSHA256: digest.toString("base64"),
      ServerSideEncryption: this.kmsKeyId ? "aws:kms" : "AES256",
      ...(this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
      Metadata: {
        application: owner.applicationId,
        tenant: owner.tenantId,
        run: runId,
        sha256: digest.toString("hex"),
        "expires-at": expiresAt,
      },
    }));
    return { id, kind, name: displayName, uri: artifactUri(key), contentType, sha256: digest.toString("hex") };
  }

  private async get(owner: OwnerScope, key: string): Promise<GetObjectCommandOutput> {
    this.assertOwnedKey(owner, key);
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ChecksumMode: "ENABLED",
    })) as GetObjectCommandOutput;
    if (result.Metadata?.application !== owner.applicationId || result.Metadata?.tenant !== owner.tenantId) {
      throw new ArtifactOwnershipError();
    }
    return result;
  }

  private key(owner: OwnerScope, runId: string, relativeName: string): string {
    const relative = relativeName.split("/").map(safeSegment).join("/");
    return `${this.ownerPrefix(owner)}${safeSegment(runId)}/${relative}`;
  }

  private assertOwnedKey(owner: OwnerScope, key: string): void {
    if (!key.startsWith(this.ownerPrefix(owner)) && !key.startsWith(this.legacyOwnerPrefix(owner))) {
      throw new ArtifactOwnershipError();
    }
  }

  private ownerPrefix(owner: OwnerScope): string {
    return `${this.prefix}${artifactOwnerSegment(owner.applicationId)}/${artifactOwnerSegment(owner.tenantId)}/`;
  }

  /** Existing objects remain readable and are still protected by exact owner metadata. */
  private legacyOwnerPrefix(owner: OwnerScope): string {
    return `${this.prefix}${safeSegment(owner.applicationId)}/${safeSegment(owner.tenantId)}/`;
  }
}

export class ArtifactNotFoundError extends Error {
  constructor() { super("Artifact was not found"); this.name = "ArtifactNotFoundError"; }
}

export class ArtifactOwnershipError extends Error {
  constructor() { super("Artifact does not belong to the requested owner"); this.name = "ArtifactOwnershipError"; }
}

export class ArtifactIntegrityError extends Error {
  constructor() { super("Artifact checksum metadata does not match its reference"); this.name = "ArtifactIntegrityError"; }
}

function artifactUri(key: string): string {
  return `qasey-artifact:${encodeURIComponent(key)}`;
}

function artifactKeyFromUri(uri: string): string {
  if (!uri.startsWith("qasey-artifact:")) throw new ArtifactNotFoundError();
  try {
    const key = decodeURIComponent(uri.slice("qasey-artifact:".length));
    if (!key || key.startsWith("/") || key.includes("../")) throw new ArtifactNotFoundError();
    return key;
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) throw error;
    throw new ArtifactNotFoundError();
  }
}

function normalizePrefix(value: string): string {
  const segments = value.split("/").filter(Boolean).map(safeSegment);
  if (segments.length === 0) throw new Error("S3 artifact prefix must not be empty");
  return `${segments.join("/")}/`;
}

function requiredSegment(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value.trim();
}

async function bodyToBuffer(body: GetObjectCommandOutput["Body"]): Promise<Buffer> {
  if (!body?.transformToByteArray) throw new ArtifactNotFoundError();
  return Buffer.from(await body.transformToByteArray());
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+$/u, "-").slice(0, 160);
  if (!segment) throw new Error("Artifact owner scope contains an empty path segment");
  return segment;
}

/**
 * Injective, versioned encoding for security-sensitive owner path segments.
 * Slug replacement is intentionally not used here because distinct tenant IDs
 * such as `tenant/a` and `tenant-a` must never share an artifact prefix.
 */
export function artifactOwnerSegment(value: string): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length === 0 || encoded.length > 256) {
    throw new Error("Artifact owner scope must contain between 1 and 256 UTF-8 bytes");
  }
  return `v1-${encoded.toString("base64url")}`;
}
