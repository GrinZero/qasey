import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(masterKey: string): Buffer {
  return createHash("sha256").update("qasey-sandbox-lease-v1\0").update(masterKey).digest();
}

export function encryptSandboxSecret(value: string, masterKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(masterKey), nonce);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSandboxSecret(value: string, masterKey: string): string {
  const [version, nonce, tag, encrypted] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !encrypted) throw new Error("Unsupported sandbox lease secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(masterKey), Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

