import { GetObjectCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRef, OwnerScope } from "../../packages/contracts/src/index.ts";
import {
  ArtifactIntegrityError,
  ArtifactOwnershipError,
  LocalArtifactStore,
  S3ArtifactStore,
} from "../../packages/e2e/src/index.ts";

const owner: OwnerScope = { applicationId: "qasey", tenantId: "tenant-a" };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("artifact ownership boundary", () => {
  it("streams local artifacts only inside the authenticated owner root", async () => {
    const root = await mkdtemp(join(tmpdir(), "qasey-artifacts-"));
    temporaryDirectories.push(root);
    const store = new LocalArtifactStore(root);
    const ref = await store.savePatch(owner, "run-1", "diff --git a/a b/a\n");

    const opened = await store.open(owner, ref);
    await expect(new Response(opened.body).text()).resolves.toContain("diff --git");
    await expect(store.open({ ...owner, tenantId: "tenant-b" }, ref)).rejects.toBeInstanceOf(ArtifactOwnershipError);
  });

  it("stores shared artifacts with encryption, checksum and retention metadata", async () => {
    const client = new FakeS3Client();
    const store = new S3ArtifactStore({
      bucket: "qasey-artifacts",
      region: "us-east-1",
      prefix: "production/evidence",
      kmsKeyId: "alias/qasey-artifacts",
      retentionDays: 14,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      client,
    });

    const ref = await store.savePatch(owner, "run-1", "safe patch");

    expect(ref.uri).toMatch(/^qasey-artifact:/u);
    expect(ref.uri).not.toContain("qasey-artifacts");
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const put = client.commands.find(command => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: "qasey-artifacts",
      Key: "production/evidence/v1-cWFzZXk/v1-dGVuYW50LWE/run-1/changes.patch",
      ContentType: "text/x-diff",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "alias/qasey-artifacts",
      Metadata: {
        application: "qasey",
        tenant: "tenant-a",
        run: "run-1",
        "expires-at": "2026-09-09T00:00:00.000Z",
      },
    });
    expect(put.input.ChecksumSHA256).toBeTruthy();
    await expect(store.loadPatch(owner, "run-1")).resolves.toBe("safe patch");
    const opened = await store.open(owner, ref);
    await expect(new Response(opened.body).text()).resolves.toBe("safe patch");
    await store.healthCheck();
    expect(client.commands.some(command => command instanceof HeadBucketCommand)).toBe(true);
  });

  it("rejects cross-tenant keys and checksum metadata mismatches", async () => {
    const client = new FakeS3Client();
    const store = new S3ArtifactStore({ bucket: "bucket", region: "region", client });
    const ref = await store.savePatch(owner, "run-1", "patch");

    await expect(store.open({ ...owner, tenantId: "tenant-b" }, ref)).rejects.toBeInstanceOf(ArtifactOwnershipError);
    const tampered: ArtifactRef = { ...ref, sha256: "0".repeat(64) };
    await expect(store.open(owner, tampered)).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("uses collision-free owner prefixes for IDs that normalize to the same slug", async () => {
    const client = new FakeS3Client();
    const store = new S3ArtifactStore({ bucket: "bucket", region: "region", client });
    await store.savePatch({ applicationId: "qasey", tenantId: "tenant/a" }, "run-1", "one");
    await store.savePatch({ applicationId: "qasey", tenantId: "tenant-a" }, "run-1", "two");

    const keys = client.commands
      .filter(command => command instanceof PutObjectCommand)
      .map(command => String((command as PutObjectCommand).input.Key));
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

class FakeS3Client {
  readonly commands: object[] = [];
  readonly destroy = vi.fn();
  private readonly objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>();

  async send(command: object): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key);
      this.objects.set(key, {
        body: Buffer.from(command.input.Body as Uint8Array),
        metadata: command.input.Metadata ?? {},
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.objects.get(String(command.input.Key));
      if (!stored) throw new Error("NoSuchKey");
      return {
        Metadata: stored.metadata,
        ContentLength: stored.body.length,
        Body: {
          transformToByteArray: async () => new Uint8Array(stored.body),
          transformToWebStream: () => new Blob([Uint8Array.from(stored.body)]).stream(),
        },
      };
    }
    if (command instanceof HeadBucketCommand) return {};
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}
