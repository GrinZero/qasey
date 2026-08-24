import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { OAuthStorage } from "@mastra/mcp";

export class FileOAuthStorage implements OAuthStorage {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.read();
    data[key] = value;
    await this.write(data);
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read())[key];
  }

  async delete(key: string): Promise<void> {
    const data = await this.read();
    delete data[key];
    await this.write(data);
  }
}

function encryptionKey(masterKey: string): Buffer {
  return scryptSync(masterKey, "qasey-mcp-oauth-v1", 32);
}

function encrypt(value: string, masterKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(masterKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(value: string, masterKey: string): string {
  const [version, nonce, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext) throw new Error("Unsupported OAuth credential format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(masterKey), Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export class PrismaOAuthStorageBackend {
  private initialized?: Promise<void>;

  constructor(private readonly prisma: PrismaClient) {}

  init(): Promise<void> {
    this.initialized ??= this.prisma.$connect();
    return this.initialized;
  }

  private ready(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("PrismaOAuthStorageBackend has not been initialized"));
    return this.initialized;
  }

  async healthCheck(): Promise<void> {
    await this.ready();
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async set(namespace: string, key: string, encryptedValue: string): Promise<void> {
    await this.ready();
    await this.prisma.qaseyMcpOAuthCredential.upsert({
      where: { namespace_storageKey: { namespace, storageKey: key } },
      create: { namespace, storageKey: key, encryptedValue },
      update: { encryptedValue, updatedAt: new Date() },
    });
  }

  async get(namespace: string, key: string): Promise<string | undefined> {
    await this.ready();
    const result = await this.prisma.qaseyMcpOAuthCredential.findUnique({
      where: { namespace_storageKey: { namespace, storageKey: key } },
      select: { encryptedValue: true },
    });
    return result?.encryptedValue;
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.ready();
    await this.prisma.qaseyMcpOAuthCredential.deleteMany({ where: { namespace, storageKey: key } });
  }

  async close(): Promise<void> {}
}

export class PrismaOAuthStorage implements OAuthStorage {
  constructor(
    private readonly backend: PrismaOAuthStorageBackend,
    private readonly masterKey: string,
    private readonly namespace: string,
  ) {}

  async set(key: string, value: string): Promise<void> {
    await this.backend.set(this.namespace, key, encrypt(value, this.masterKey));
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.backend.get(this.namespace, key);
    return value ? decrypt(value, this.masterKey) : undefined;
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(this.namespace, key);
  }
}
