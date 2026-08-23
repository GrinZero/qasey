import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type SlackCredentialField = "bot-token" | "signing-secret";

export interface SlackCredentialContext {
  tenantId: string;
  installationId: string;
  field: SlackCredentialField;
}

function keyFrom(masterKey: string): Buffer {
  if (!masterKey.trim()) throw new Error("Slack credential encryption key must not be empty");
  return createHash("sha256").update(masterKey).digest();
}

function additionalData(context: SlackCredentialContext): Buffer {
  return Buffer.from([
    "qasey-slack-credential",
    context.tenantId,
    context.installationId,
    context.field,
  ].join("\u0000"), "utf8");
}

export function encryptSlackCredential(
  value: string,
  masterKey: string,
  context: SlackCredentialContext,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(masterKey), nonce);
  cipher.setAAD(additionalData(context));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    "default",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptSlackCredential(
  value: string,
  masterKey: string,
  context: SlackCredentialContext,
): string {
  const [version, keyId, nonce, tag, encrypted] = value.split(".");
  if (version !== "v1" || keyId !== "default" || !nonce || !tag || !encrypted) {
    throw new Error("Unsupported Slack credential format");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(masterKey), Buffer.from(nonce, "base64url"));
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
