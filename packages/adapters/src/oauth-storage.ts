import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { OAuthStorage } from "@mastra/mcp";
import { z } from "zod";
import type { OwnerScope } from "../../contracts/src/index.ts";
import type { RuntimeCredentialKeyring } from "./config.ts";

const OAUTH_NAMESPACE_PREFIX = "qasey";
const OAuthOwnerFieldSchema = z.string().trim().min(1).max(255)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain control characters");
const OAuthConnectorIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, "must be a canonical connector identifier");
const OAuthAccountIdSchema = OAuthOwnerFieldSchema;
const OAuthCredentialAddressSchema = z.object({
  owner: z.object({
    applicationId: OAuthOwnerFieldSchema,
    tenantId: OAuthOwnerFieldSchema,
  }).strict(),
  connectorId: OAuthConnectorIdSchema,
  accountId: OAuthAccountIdSchema,
}).strict();
const OAuthStorageKeySchema = z.string().trim().min(1).max(255)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain control characters");

export interface McpOAuthCredentialAddress {
  owner: OwnerScope;
  connectorId: string;
  accountId: string;
}

export function mcpOAuthCredentialNamespace(input: McpOAuthCredentialAddress): string {
  const address = normalizeAddress(input);
  return [
    OAUTH_NAMESPACE_PREFIX,
    address.owner.applicationId,
    address.owner.tenantId,
    address.accountId,
    address.connectorId,
  ].map((value, index) => index === 0 ? value : encodeURIComponent(value)).join(":");
}

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

function encryptionKey(masterKey: string, version: "v1" | "v2"): Buffer {
  return scryptSync(masterKey, `qasey-mcp-oauth-${version}`, 32);
}

function encrypt(
  value: string,
  keyring: RuntimeCredentialKeyring,
  namespace: string,
  storageKey: string,
): string {
  const masterKey = keyring.keys[keyring.activeKeyId];
  if (!masterKey) throw new Error("Active MCP OAuth encryption key is unavailable");
  const nonce = randomBytes(12);
  // Keep emitting the legacy envelope until the operator deliberately flips
  // away from the default key ID. This permits an expand-only code rollout
  // before the key rotation changes the write format.
  if (keyring.activeKeyId === "default") {
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(masterKey, "v1"), nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(masterKey, "v2"), nonce);
  cipher.setAAD(oauthContext(namespace, storageKey));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v2", keyring.activeKeyId, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(
  value: string,
  keyring: RuntimeCredentialKeyring,
  namespace: string,
  storageKey: string,
): { plaintext: string; keyId: string; version: "v1" | "v2" } {
  try {
    const segments = value.split(".");
    if (segments[0] === "v1" && segments.length === 4) {
      const masterKey = keyring.keys.default;
      if (!masterKey) throw new Error("legacy key unavailable");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(masterKey, "v1"), canonicalBase64url(segments[1]!, 12));
      decipher.setAuthTag(canonicalBase64url(segments[2]!, 16));
      return {
        plaintext: Buffer.concat([decipher.update(canonicalBase64url(segments[3]!)), decipher.final()]).toString("utf8"),
        keyId: "default",
        version: "v1",
      };
    }
    if (segments[0] === "v2" && segments.length === 5) {
      const keyId = segments[1]!;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(keyId)) throw new Error("invalid key id");
      const masterKey = keyring.keys[keyId];
      if (!masterKey) throw new Error("key unavailable");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(masterKey, "v2"), canonicalBase64url(segments[2]!, 12));
      decipher.setAAD(oauthContext(namespace, storageKey));
      decipher.setAuthTag(canonicalBase64url(segments[3]!, 16));
      return {
        plaintext: Buffer.concat([decipher.update(canonicalBase64url(segments[4]!)), decipher.final()]).toString("utf8"),
        keyId,
        version: "v2",
      };
    }
    throw new Error("unsupported format");
  } catch {
    throw new Error("OAuth credential could not be decrypted");
  }
}

function normalizeKeyring(value: string | RuntimeCredentialKeyring): RuntimeCredentialKeyring {
  const keyring = typeof value === "string"
    ? { activeKeyId: "default", keys: { default: value } }
    : value;
  if (!keyring.activeKeyId || !keyring.keys[keyring.activeKeyId]) {
    throw new Error("Active MCP OAuth encryption key is unavailable");
  }
  return keyring;
}

function canonicalBase64url(value: string, expectedLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("invalid encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error("invalid encoding");
  }
  return decoded;
}

function oauthContext(namespace: string, storageKey: string): Buffer {
  return Buffer.from(`${namespace}\0${storageKey}`, "utf8");
}

function normalizeAddress(input: McpOAuthCredentialAddress): McpOAuthCredentialAddress {
  return OAuthCredentialAddressSchema.parse(input);
}

function credentialIdentity(addressInput: McpOAuthCredentialAddress, keyInput: string): {
  namespace: string;
  key: string;
} {
  return {
    namespace: mcpOAuthCredentialNamespace(addressInput),
    key: OAuthStorageKeySchema.parse(keyInput),
  };
}

function addressFromNamespace(namespace: string): McpOAuthCredentialAddress {
  try {
    const segments = namespace.split(":");
    if (segments.length !== 5 || segments[0] !== OAUTH_NAMESPACE_PREFIX) throw new Error("invalid namespace");
    const decoded = segments.slice(1).map(segment => decodeURIComponent(segment));
    const address = normalizeAddress({
      owner: { applicationId: decoded[0]!, tenantId: decoded[1]! },
      accountId: decoded[2]!,
      connectorId: decoded[3]!,
    });
    if (mcpOAuthCredentialNamespace(address) !== namespace) throw new Error("non-canonical namespace");
    return address;
  } catch {
    throw new Error("Stored MCP OAuth credential namespace is not canonical");
  }
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

  async set(addressInput: McpOAuthCredentialAddress, keyInput: string, encryptedValue: string): Promise<void> {
    await this.ready();
    const { namespace, key } = credentialIdentity(addressInput, keyInput);
    await this.prisma.qaseyMcpOAuthCredential.upsert({
      where: { namespace_storageKey: { namespace, storageKey: key } },
      create: { namespace, storageKey: key, encryptedValue },
      update: { encryptedValue, updatedAt: new Date() },
    });
  }

  async get(addressInput: McpOAuthCredentialAddress, keyInput: string): Promise<string | undefined> {
    await this.ready();
    const { namespace, key } = credentialIdentity(addressInput, keyInput);
    const result = await this.prisma.qaseyMcpOAuthCredential.findUnique({
      where: { namespace_storageKey: { namespace, storageKey: key } },
      select: { encryptedValue: true },
    });
    return result?.encryptedValue;
  }

  async replace(
    addressInput: McpOAuthCredentialAddress,
    keyInput: string,
    expectedValue: string,
    encryptedValue: string,
  ): Promise<boolean> {
    await this.ready();
    const { namespace, key } = credentialIdentity(addressInput, keyInput);
    const result = await this.prisma.qaseyMcpOAuthCredential.updateMany({
      where: { namespace, storageKey: key, encryptedValue: expectedValue },
      data: { encryptedValue, updatedAt: new Date() },
    });
    return result.count === 1;
  }

  async rotateAll(keyringInput: RuntimeCredentialKeyring, batchSize = 100): Promise<number> {
    await this.ready();
    const keyring = normalizeKeyring(keyringInput);
    let cursor: { namespace: string; storageKey: string } | undefined;
    let rotated = 0;
    for (;;) {
      const rows = await this.prisma.qaseyMcpOAuthCredential.findMany({
        take: batchSize,
        ...(cursor ? {
          skip: 1,
          cursor: { namespace_storageKey: cursor },
        } : {}),
        orderBy: [{ namespace: "asc" }, { storageKey: "asc" }],
        select: { namespace: true, storageKey: true, encryptedValue: true },
      });
      for (const row of rows) {
        const address = addressFromNamespace(row.namespace);
        const storageKey = OAuthStorageKeySchema.parse(row.storageKey);
        const current = decrypt(row.encryptedValue, keyring, row.namespace, row.storageKey);
        if (current.keyId === keyring.activeKeyId) continue;
        const next = encrypt(current.plaintext, keyring, row.namespace, row.storageKey);
        if (await this.replace(address, storageKey, row.encryptedValue, next)) rotated += 1;
      }
      if (rows.length < batchSize) break;
      const last = rows.at(-1)!;
      cursor = { namespace: last.namespace, storageKey: last.storageKey };
    }
    return rotated;
  }

  async delete(addressInput: McpOAuthCredentialAddress, keyInput: string): Promise<void> {
    await this.ready();
    const { namespace, key } = credentialIdentity(addressInput, keyInput);
    await this.prisma.qaseyMcpOAuthCredential.deleteMany({ where: { namespace, storageKey: key } });
  }

  async close(): Promise<void> {}
}

export class PrismaOAuthStorage implements OAuthStorage {
  private readonly keyring: RuntimeCredentialKeyring;
  private readonly address: McpOAuthCredentialAddress;
  private readonly namespace: string;

  constructor(
    private readonly backend: PrismaOAuthStorageBackend,
    keyring: string | RuntimeCredentialKeyring,
    address: McpOAuthCredentialAddress,
  ) {
    this.keyring = normalizeKeyring(keyring);
    this.address = normalizeAddress(address);
    this.namespace = mcpOAuthCredentialNamespace(this.address);
  }

  async set(key: string, value: string): Promise<void> {
    const storageKey = OAuthStorageKeySchema.parse(key);
    await this.backend.set(this.address, storageKey, encrypt(value, this.keyring, this.namespace, storageKey));
  }

  async get(key: string): Promise<string | undefined> {
    const storageKey = OAuthStorageKeySchema.parse(key);
    const value = await this.backend.get(this.address, storageKey);
    if (!value) return undefined;
    const current = decrypt(value, this.keyring, this.namespace, storageKey);
    if (current.keyId !== this.keyring.activeKeyId) {
      await this.backend.replace(
        this.address,
        storageKey,
        value,
        encrypt(current.plaintext, this.keyring, this.namespace, storageKey),
      );
    }
    return current.plaintext;
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(this.address, OAuthStorageKeySchema.parse(key));
  }
}
