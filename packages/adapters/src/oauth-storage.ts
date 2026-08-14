import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
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

export class PostgresOAuthStorage implements OAuthStorage {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string, private readonly masterKey: string, private readonly namespace: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.pool.query(`CREATE TABLE IF NOT EXISTS qasey_mcp_oauth_credentials (
      namespace text NOT NULL,
      storage_key text NOT NULL,
      encrypted_value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(namespace, storage_key)
    )`).then(() => undefined);
    return this.initialized;
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensureInitialized();
    await this.pool.query(`INSERT INTO qasey_mcp_oauth_credentials(namespace, storage_key, encrypted_value)
      VALUES($1,$2,$3) ON CONFLICT(namespace, storage_key) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value, updated_at=now()`,
    [this.namespace, key, encrypt(value, this.masterKey)]);
  }

  async get(key: string): Promise<string | undefined> {
    await this.ensureInitialized();
    const result = await this.pool.query<{ encrypted_value: string }>(
      "SELECT encrypted_value FROM qasey_mcp_oauth_credentials WHERE namespace=$1 AND storage_key=$2",
      [this.namespace, key],
    );
    return result.rows[0] ? decrypt(result.rows[0].encrypted_value, this.masterKey) : undefined;
  }

  async delete(key: string): Promise<void> {
    await this.ensureInitialized();
    await this.pool.query("DELETE FROM qasey_mcp_oauth_credentials WHERE namespace=$1 AND storage_key=$2", [this.namespace, key]);
  }
}
